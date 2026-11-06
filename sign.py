#!/usr/bin/env python3
"""
sign.py - puts your own @ on the edit's closing card.

    python sign.py @chitrivjr

writes feelings_for_you.mp4 (feelings.mp4 itself is never touched). the closing
card bounces in with motion blur and two colour flashes; that motion is measured
frame by frame from the original and the new name is put through exactly the same.
the song is copied across untouched.
"""

from __future__ import annotations

import argparse
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from art import find_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "feelings.mp4")
OUT = os.path.join(HERE, "feelings_for_you.mp4")
FONT = r"C:\Windows\Fonts\arialbd.ttf"          # the closest match to the edit's typeface
NARROW = r"C:\Windows\Fonts\ARIALNB.TTF"         # for the gift's big letters: narrow and tall reads best
OLD = "@sumithsai_"                              # what the card says now
INK = np.array([77, 0, 36], float)               # its colours at rest
W = H = 720
FPS = 30000 / 1001


def frames(ff, path, start=0.0):
    """decode a video one frame at a time, as (H, W, 3) uint8."""
    p = subprocess.Popen([ff, "-nostdin", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", path, "-an",
                          "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = W * H * 3
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(H, W, 3)
    finally:                                                    # stopped early: stop ffmpeg too
        p.kill()
        p.wait()


def paper_and_ink(f):
    """the card's flat background, and its text colour (dark on the pink card, light on the flashes)."""
    edge = np.concatenate([f[:120].reshape(-1, 3), f[:, :50].reshape(-1, 3), f[:, -50:].reshape(-1, 3)])
    paper = np.median(edge, 0)
    if paper.mean() > 128:
        return paper, INK
    lum = f.reshape(-1, 3).mean(1)
    return paper, np.median(f.reshape(-1, 3)[lum >= np.percentile(lum, 99.5)], 0)


def coverage(f, paper, ink):
    """how much text covers each pixel, 0..1, read off the channel with the most contrast."""
    c = int(np.argmax(np.abs(ink - paper)))
    return np.clip((f[..., c] - paper[c]) / (ink[c] - paper[c]), 0, 1)


def is_card(f):
    """a closing-card frame: one flat colour almost everywhere."""
    paper, _ = paper_and_ink(f)
    return (np.abs(f.astype(float) - paper).max(2) < 14).mean() > 0.9


def blur_v(a, L):
    """vertical motion blur: each pixel becomes the mean of L pixels in its column."""
    if L <= 1:
        return a
    c = np.pad(np.cumsum(a, 0), ((1, 0),) + ((0, 0),) * (a.ndim - 1))
    lo = np.clip(np.arange(a.shape[0]) - L // 2, 0, a.shape[0])
    hi = np.clip(np.arange(a.shape[0]) + L - L // 2, 0, a.shape[0])
    return (c[hi] - c[lo]) / L


def shift_v(a, dy):
    out = np.zeros_like(a)
    if dy >= 0:
        out[dy:] = a[: a.shape[0] - dy]
    else:
        out[:dy] = a[-dy:]
    return out


def fit(profile, rest):
    """the shift and blur that turn the resting card's outline into this frame's."""
    best = (np.inf, 0, 1)
    for L in range(1, 122, 2):
        r = blur_v(rest, L)
        for dy in range(-300, 301):
            e = ((shift_v(r, dy) - profile) ** 2).sum()
            if e < best[0]:
                best = (e, dy, L)
    return best[1], best[2]


def name_mask(text, size, origin_y):
    """the new name, drawn sharp at the resting place, as coverage 0..1."""
    font = ImageFont.truetype(FONT, size)
    l, t, r, b = font.getbbox(text)
    im = Image.new("L", (W, H), 0)
    ImageDraw.Draw(im).text(((W - (r - l)) / 2 - l, origin_y), text, fill=255, font=font)
    return np.asarray(im, float) / 255


def signature_picture(text):
    """the name for for_you.py's big glyph letters: narrow and stretched 1.5x tall, which stays
    readable at ten-odd rows (at the edit's own proportions it turns to mush)."""
    big = ImageFont.truetype(NARROW if os.path.isfile(NARROW) else FONT, 300)
    l, t, r, b = big.getbbox(text)
    im = Image.new("L", (r - l + 40, b - t + 40), 0)
    ImageDraw.Draw(im).text((20 - l, 20 - t), text, fill=255, font=big)
    return np.asarray(im.resize((im.width, round(im.height * 1.5)), Image.LANCZOS))


def main():
    ap = argparse.ArgumentParser(description="put your own @ on the closing card")
    ap.add_argument("name", help='e.g. "@chitrivjr"')
    args = ap.parse_args()
    ff = find_ffmpeg()

    # the card at rest: where its text sits, and how big the letters are
    reader = frames(ff, SRC, 40.0)
    rest = next(reader)
    reader.close()
    paper, ink = paper_and_ink(rest)
    a_rest = coverage(rest.astype(float), paper, ink)
    ys, xs = np.nonzero(a_rest > 0.5)
    width, top = xs.max() - xs.min() + 1, ys.min()
    size = min(range(40, 200), key=lambda s: abs(np.subtract(*ImageFont.truetype(FONT, s).getbbox(OLD)[2::-2]) - width))
    font = ImageFont.truetype(FONT, size)
    origin_y = top - font.getbbox(OLD)[1]                       # same baseline as the old name
    new_rest = name_mask(args.name, size, origin_y)
    old_profile = a_rest.sum(1)

    enc = subprocess.Popen([ff, "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{W}x{H}", "-framerate", "30000/1001", "-i", "-", "-i", SRC,
                            "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "15", "-preset", "slow",
                            "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", OUT],
                           stdin=subprocess.PIPE)
    changed, motion = 0, []
    for k, f in enumerate(frames(ff, SRC)):
        if k / FPS > 36.5 and is_card(f):
            paper, ink = paper_and_ink(f)
            dy, L = fit(coverage(f.astype(float), paper, ink).sum(1), old_profile)
            a = blur_v(shift_v(new_rest, dy), L)[..., None]
            f = np.clip(paper + (ink - paper) * a, 0, 255).astype(np.uint8)
            if changed < 14:
                print(f"  card frame {k} ({k / FPS:5.2f}s): moved {dy:+4d}px, blur {L:3d}px")
            motion.append((k / FPS, dy / H, float(paper.mean() < 128)))      # (dark paper = a flash)
            changed += 1
        enc.stdin.write(np.ascontiguousarray(f).tobytes())
    enc.stdin.close()
    enc.wait()
    print(f"re-signed {changed} closing-card frames -> {OUT}")

    # the name as a big picture too, with the card's motion, so for_you.py can show it clearly
    track = np.array(motion) if motion else np.zeros((1, 3))
    start = track[0, 0]
    track[:, 0] -= start                                        # seconds since the card came up
    moving = np.flatnonzero(np.abs(track[:, 1]) > 0.002)
    track = track[: moving.max() + 2 if len(moving) else 1]     # until it settles
    np.savez_compressed(os.path.join(HERE, "signature.npz"), alpha=signature_picture(args.name),
                        name=np.array(args.name), start=np.array(start), track=track)
    print("saved signature.npz for the gift")


if __name__ == "__main__":
    main()
