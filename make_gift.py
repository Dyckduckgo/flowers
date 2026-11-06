#!/usr/bin/env python3
"""
make_gift.py - packs for_you.py into one double-click "for you.exe" that runs on any
Windows PC, with nothing to install.

    pip install pyinstaller numpy imageio-ffmpeg pillow      (once)
    python make_gift.py

the edit is decoded ahead of time (its frames, and the song as a wav), so the .exe
carries no ffmpeg. the result lands in dist/for you.exe
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import wave

import numpy as np

from art import CROP, Video, find_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
SIDE = 256                     # the edit is stored 256 x 256; the player resizes it to fit any window


def bake(ff, src):
    """the edit's frames (5 bits a colour - all the art ever shows) and its song, ready to ship."""
    os.makedirs(BUILD, exist_ok=True)
    wav, frames_out = os.path.join(BUILD, "feelings.wav"), os.path.join(BUILD, "feelings_frames.npz")
    if all(os.path.isfile(p) and os.path.getmtime(p) > os.path.getmtime(src) for p in (wav, frames_out)):
        print("using the frames and song baked last time")
        return frames_out, wav
    subprocess.run([ff, "-nostdin", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100",
                    "-c:a", "pcm_s16le", wav], check=True)
    with wave.open(wav) as w:
        seconds = w.getnframes() / w.getframerate()
    vf = f"fps=30,crop=iw*{CROP}:ih*{CROP},scale={SIDE}:{SIDE}:flags=area,format=gbrp"
    raw = subprocess.run([ff, "-nostdin", "-loglevel", "error", "-i", src, "-an", "-vf", vf, "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, 3, SIDE, SIDE) & 0xF8
    meta = np.array([30.0, seconds, Video(ff, src).aspect])
    np.savez_compressed(frames_out, meta=meta, **{f"f{i:04d}": f for i, f in enumerate(frames)})
    print(f"baked {len(frames)} frames ({os.path.getsize(frames_out) / 1e6:.1f} MB) and {seconds:.1f}s of song")
    return frames_out, wav


def heart_icon(path):
    """a soft pink heart for the .exe."""
    from PIL import Image, ImageDraw, ImageFilter
    S = 256
    t = np.linspace(0, 2 * np.pi, 600)
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    outline = [(S / 2 + a * S / 37, S / 2 - b * S / 37 + S * 0.04) for a, b in zip(x, y)]
    halo = Image.new("L", (S, S), 0)
    ImageDraw.Draw(halo).polygon(outline, fill=150)
    halo = halo.filter(ImageFilter.GaussianBlur(10))
    shape = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shape).polygon(outline, fill=255)
    rows = np.linspace(0, 1, S)[:, None]
    fill = np.zeros((S, S, 4), np.uint8)
    fill[..., 0] = 255
    fill[..., 1] = (64 + 120 * (1 - rows) ** 2).astype(np.uint8).repeat(S, 1)
    fill[..., 2] = (129 + 80 * (1 - rows) ** 2).astype(np.uint8).repeat(S, 1)
    fill[..., 3] = 255
    img = Image.new("RGBA", (S, S), (255, 64, 129, 0))
    img.putalpha(halo)
    img.paste(Image.fromarray(fill, "RGBA"), (0, 0), shape)
    shine = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shine).ellipse((S * 0.25, S * 0.24, S * 0.42, S * 0.36), fill=120)
    img.paste((255, 255, 255, 255), (0, 0), shine.filter(ImageFilter.GaussianBlur(6)))
    img.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    ap = argparse.ArgumentParser(description="pack for_you.py into one .exe")
    ap.add_argument("--python", default=sys.executable, help="the python that has PyInstaller installed")
    args = ap.parse_args()

    ff = find_ffmpeg()
    signed = os.path.join(HERE, "feelings_for_you.mp4")          # made by sign.py, if you've run it
    frames, wav = bake(ff, signed if os.path.isfile(signed) else os.path.join(HERE, "feelings.mp4"))
    icon = os.path.join(HERE, "heart.ico")
    if not os.path.isfile(icon):
        heart_icon(icon)
    data = [frames, wav, os.path.join(HERE, "flowers_word.npz")]
    if os.path.isfile(os.path.join(HERE, "signature.npz")):     # your @ from sign.py
        data.append(os.path.join(HERE, "signature.npz"))
    cmd = [args.python, "-m", "PyInstaller", "--noconfirm", "--onefile", "--console", "--name", "for you",
           "--icon", icon, "--distpath", os.path.join(HERE, "dist"), "--workpath", os.path.join(BUILD, "work"),
           "--specpath", BUILD]
    for path in data:
        cmd += ["--add-data", f"{path}{os.pathsep}."]
    for mod in ("tkinter", "PIL", "imageio_ffmpeg", "matplotlib", "scipy", "pandas", "IPython", "pytest"):
        cmd += ["--exclude-module", mod]
    subprocess.run(cmd + [os.path.join(HERE, "for_you.py")], check=True, cwd=HERE)
    exe = os.path.join(HERE, "dist", "for you.exe")
    print(f"\ndone: {exe}  ({os.path.getsize(exe) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
