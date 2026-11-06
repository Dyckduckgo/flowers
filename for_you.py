#!/usr/bin/env python3
"""
for_you.py - i grew some flowers for you.

    python for_you.py          (or double-click for_you.bat)

a little card, and when you press enter a garden grows under the stars and
turns, slowly, while the song plays beside it.

keys:   enter  begin        up / down  turn faster / slower
        r  play it again     q  close

lives next to art.py, flowers.py, feelings.mp4 and flowers_word.npz
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time

import numpy as np

from art import (CHARS, SHAPE, SHAPE_E, TONE, Frames, Ink, Screen, Sound, Stars, Terminal, Video,
                 dim, find_ffmpeg, pack, to_cells)
from flowers import TAU, Garden, Keys, Sky, View, moon

HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))   # (inside the .exe too)
SONG = next((p for p in (os.path.join(HERE, "feelings_for_you.mp4"), os.path.join(HERE, "feelings.mp4"))
             if os.path.isfile(p)), os.path.join(HERE, "feelings.mp4"))    # the signed copy (sign.py) first
WORD = os.path.join(HERE, "flowers_word.npz")      # "flowers", handwritten, as a picture
BAKED = os.path.join(HERE, "feelings_frames.npz")  # the edit decoded ahead of time (the sendable .exe)
TUNE = os.path.join(HERE, "feelings.wav")          # and its song
SIGNATURE = os.path.join(HERE, "signature.npz")    # your @, from sign.py: shown big when the edit signs off
CARD_AT = 37.27                                    # the second the edit's closing card appears
FPS, SPIN = 30.0, 0.12                               # frames a second; turns a second once it blooms

# the edit's colours: hot pink, rose, blush, a little mist, and a deep wine for things barely there
HOT = np.array([255, 64, 129]) / 255
ROSE = np.array([236, 92, 140]) / 255
BLUSH = np.array([255, 196, 214]) / 255
MIST = np.array([236, 220, 228]) / 255
WINE = np.array([110, 24, 60]) / 255
CYAN = np.array([90, 230, 255]) / 255


def ink_of(c, k=1.0):
    """one colour (r, g, b in 0-1), scaled by k, as the screen's packed int."""
    return int(pack(np.clip(np.asarray(c, float) * k, 0, 1)[:, None])[0])


def spaced(text):
    """'for you' -> 'f o r   y o u': small, airy letters."""
    return "   ".join(" ".join(word) for word in text.split())


def heartbeat(t):
    """two quick beats, then a rest."""
    p = t % 1.15
    return math.exp(-(p / 0.07) ** 2) + 0.65 * math.exp(-((p - 0.22) / 0.08) ** 2)


# ── the handwritten word ────────────────────────────────────────────────────
def area_resize(a, h, w):
    """box-filter a picture down to h x w (every output pixel is the mean of its patch)."""
    H, W = a.shape
    ys, xs = np.linspace(0, H, h + 1).astype(int), np.linspace(0, W, w + 1).astype(int)
    c = np.pad(a.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    total = (c[ys[1:, None], xs[None, 1:]] - c[ys[:-1, None], xs[None, 1:]]
             - c[ys[1:, None], xs[None, :-1]] + c[ys[:-1, None], xs[None, :-1]])
    return total / np.maximum((ys[1:] - ys[:-1])[:, None] * (xs[1:] - xs[:-1])[None, :], 1)


def resample(a, h, w):
    """one picture plane to h x w: averaged when shrinking, nearest pixel when growing."""
    H, W = a.shape
    if h <= H and w <= W:
        return np.rint(area_resize(a, h, w)).astype(np.uint8)
    return a[(np.arange(h) * H // h)][:, (np.arange(w) * W // w)]


class Baked:
    """the edit's frames, decoded ahead of time by make_gift.py, so the .exe needs no ffmpeg.
    hands out frames just like art.Frames does: ask for frame n, get (3, h, w) planes back."""

    def __init__(self, path, size, start, fps):
        self.npz = np.load(path)
        self.count = len(self.npz.files) - 1
        self.w, self.h = size
        self.first = round(start * fps)
        side = self.npz["f0000"].shape[1]
        self.near = min(self.w, self.h) >= side * 0.7          # close to stored size: just pick pixels
        self.ys = ((np.arange(self.h) + 0.5) * side / self.h).astype(int)[:, None]
        self.xs = ((np.arange(self.w) + 0.5) * side / self.w).astype(int)[None, :]

    def get(self, n):
        if n >= self.count:
            return None
        planes = self.npz[f"f{n:04d}"]
        if self.near:
            return planes[:, self.ys, self.xs]
        return np.stack([resample(p, self.h, self.w) for p in planes])

    def close(self):
        self.npz.close()


class Tune(Sound):
    """the song as a ready-made wav (the .exe carries it), played the same way art.py does."""

    def __init__(self, path):
        self.wav, self.extract, self.ok, self.proc = path, None, os.path.isfile(path), None

    def ready(self):
        return self.ok

    def close(self):
        self.stop()                                              # (the wav belongs to the bundle)


_words = {}


def word_art(cols, path=WORD):
    """a word picture as glyphs: solid strokes get dense letters, their edges get matching shapes."""
    if (path, cols) not in _words:
        if not os.path.isfile(path):
            return None
        a = np.load(path)["alpha"] / 255.0
        rows = max(2, round(cols * a.shape[0] / a.shape[1] / 2))      # cells are twice as tall as wide
        cells = area_resize(a, rows * 8, cols * 4).reshape(rows, 8, cols, 4).transpose(0, 2, 1, 3)
        cells = cells.reshape(rows * cols, 32)
        grain = np.random.default_rng(9).uniform(0.8, 1.0, len(cells))
        glyph = TONE[np.clip(cells.mean(1) * grain * 255, 0, 255).astype(int)]
        edge = cells.std(1) > 0.2
        glyph[edge] = (SHAPE_E - 2 * (0.82 * cells[edge]) @ SHAPE.T).argmin(1)
        _words[path, cols] = (glyph.reshape(rows, cols), cells.mean(1).reshape(rows, cols))
    return _words[path, cols]


# ── the card ────────────────────────────────────────────────────────────────
class Poster:
    """i grew some / flowers / for you, laid out inside one box of the screen."""

    def __init__(self, x, y, w, h, prompt="press enter"):
        cols = int(min(w * 0.66, max(0, h - 8) * 4.0))
        art = word_art(cols) if cols >= 18 else None
        self.word, self.cover = art if art else (None, None)
        rows = self.word.shape[0] if art else 1
        top = y + max(0, (h - (rows + 7)) // 2)
        self.box = (x, y, w, h)
        self.cols, self.rows = (cols, rows) if art else (len(spaced("flowers")), 1)
        self.wx, self.wy = x + (w - self.cols) // 2, top + 2
        self.line1, self.line2 = spaced("i grew some"), spaced("for you")
        self.at1 = (self.wx + int(self.cols * 0.04), top)
        self.at2 = (self.wx + int(self.cols * 0.96) - len(self.line2) - 3, top + 2 + rows + 1)
        self.prompt = f"·   {spaced(prompt)}   ·"
        self.atp = (x + (w - len(self.prompt)) // 2, min(y + h - 1, top + rows + 6))
        rng = np.random.default_rng(12)
        self.sparks = np.stack([rng.uniform(self.wx - 5, self.wx + self.cols + 5, 9),
                                rng.uniform(top - 1, top + rows + 4, 9), rng.uniform(0, TAU, 9)], 1)

    def draw(self, scr, t, shake=0.0, rng=None):
        """t: seconds since the card began. shake > 0 glitches it, like the edit's FROM YOU."""
        jolt = (lambda: int(rng.integers(-2, 3)) if rng is not None and rng.random() < shake else 0)
        x, y = self.at1
        n = int(np.clip((t - 0.8) / 1.0, 0, 1) * len(self.line1))
        if n:
            scr.put(x + jolt(), y, self.line1[:n], ink_of(MIST, 0.85))
        if self.word is not None:
            self._word(scr, t, float(np.clip((t - 1.6) / 2.0, 0, 1)), shake, rng)
        elif t > 1.6:
            scr.put(self.wx + jolt(), self.wy, spaced("flowers")[: int((t - 1.6) / 0.08)], ink_of(HOT))
        x, y = self.at2
        n = int(np.clip((t - 3.5) / 0.8, 0, 1) * len(self.line2))
        if n:
            scr.put(x + jolt(), y, self.line2[:n], ink_of(MIST, 0.85))
        if t > 4.3:                                              # the heart, beating
            beat = heartbeat(t - 4.3)
            scr.put(x + len(self.line2) + 3 + jolt(), y, "♥", ink_of(HOT * (0.65 + 0.35 * beat) + 0.25 * beat))
        if t > 2.0:
            self._sparkles(scr, t)
        if t > 4.8 and shake == 0:                               # and a soft nudge to begin
            glow = min(1.0, (t - 4.8) / 0.8) * (0.6 + 0.28 * math.sin((t - 4.8) * 2.4))
            scr.put(*self.atp, self.prompt, ink_of(BLUSH, glow))

    def _word(self, scr, t, sweep, shake, rng):
        rows, cols = self.word.shape
        fy, fx = np.mgrid[0:rows, 0:cols] / np.array([max(rows - 1, 1), max(cols - 1, 1)])[:, None, None]
        show = (self.word > 0) & (fx <= sweep)
        mix = np.clip(fx * 0.85 + fy * 0.15, 0, 1)
        base = HOT[:, None, None] * (1 - mix) + BLUSH[:, None, None] * mix
        pen = np.exp(-((fx - sweep) / 0.025) ** 2) * (sweep < 1)          # glow where it's writing
        band = ((t - 4.0) * 0.32) % 1.8 - 0.4                              # a slow shine passing over
        shine = np.exp(-((fx - band + 0.15 * fy) / 0.05) ** 2) * (t > 4.0)
        colour = np.clip(base * (0.62 + 0.38 * self.cover) + (pen + 0.55 * shine) * 0.6, 0, 1)
        ys, xs = np.nonzero(show)
        if not len(ys):
            return
        shift = np.zeros(rows, int)
        if shake > 0:                                                      # glitch: torn rows, split colour
            torn = rng.random(rows) < shake * 0.6
            shift[torn] = rng.integers(-4, 5, torn.sum())
            for dx, tint in ((-1, CYAN), (1, HOT)):
                self._put(scr, ys, xs + shift[ys] + dx, self.word[ys, xs], np.tile(tint[:, None] * 0.75, len(ys)))
        self._put(scr, ys, xs + shift[ys], self.word[ys, xs], colour[:, ys, xs])
        if sweep < 1:                                                      # the pen: a spark at the nib
            front = int(sweep * (cols - 1))
            ink = np.flatnonzero(self.word[:, max(0, front - 1): front + 1].any(1))
            if len(ink):
                self._put(scr, ink[:1], np.array([front]), np.array([CHARS.tolist().index("*")]),
                          np.ones((3, 1)))

    def _put(self, scr, ys, xs, glyphs, colour):
        cy, cx = self.wy + ys, self.wx + xs
        ok = (cy >= 0) & (cy < scr.h) & (cx >= 0) & (cx < scr.w)
        scr.ch[cy[ok], cx[ok]] = CHARS[glyphs[ok]]
        scr.fg[cy[ok], cx[ok]] = pack(colour[:, ok])

    def _sparkles(self, scr, t):
        for x, y, ph in self.sparks:
            b = max(0.0, math.sin(t * 1.6 + ph)) ** 3
            x, y = int(x), int(y)
            if b < 0.12 or not (0 <= y < scr.h and 0 <= x < scr.w) or scr.ch[y, x] != " ":
                continue
            scr.ch[y, x] = "*" if b > 0.75 else "+" if b > 0.4 else "·"
            scr.fg[y, x] = ink_of(BLUSH * 0.6 + 0.4, 0.35 + 0.65 * b)
            if b > 0.85:                                                   # a little cross of light
                for dx, dy, c in ((-1, 0, "-"), (1, 0, "-"), (0, -1, "|"), (0, 1, "|")):
                    if 0 <= y + dy < scr.h and 0 <= x + dx < scr.w and scr.ch[y + dy, x + dx] == " ":
                        scr.ch[y + dy, x + dx], scr.fg[y + dy, x + dx] = c, ink_of(BLUSH, 0.4 * b)


class Petals:
    """pink petals drifting down through the dark."""

    LOOK = np.array(list("',`.,'`"))

    def __init__(self, w, h):
        self.rng = rng = np.random.default_rng(4)
        n = max(10, w * h // 130)
        self.w, self.h = w, h
        self.x, self.y = rng.uniform(0, w, n), rng.uniform(-h, h, n)
        self.fall, self.drift = rng.uniform(1.2, 2.8, n), rng.uniform(-1.2, 1.2, n)
        self.phase = rng.uniform(0, TAU, n)
        self.tint = np.stack([HOT, ROSE, BLUSH])[rng.integers(0, 3, n)]

    def draw(self, scr, t, dt, strength=1.0):
        self.y += self.fall * dt
        self.x += (self.drift + 1.6 * np.sin(t * 1.1 + self.phase)) * dt
        gone = self.y > self.h
        self.y[gone] -= self.h + self.rng.uniform(2, 8, gone.sum())
        self.x[gone] = self.rng.uniform(0, self.w, gone.sum())
        xi, yi = self.x.astype(int) % self.w, self.y.astype(int)
        k = np.flatnonzero((yi >= 0) & (yi < self.h))
        k = k[(scr.ch[yi[k], xi[k]] == " ") & (scr.bg[yi[k], xi[k]] == 0)]
        turn = ((t * 2.2 + self.phase[k]) % TAU / TAU * len(self.LOOK)).astype(int)
        scr.ch[yi[k], xi[k]] = self.LOOK[turn]
        scr.fg[yi[k], xi[k]] = pack((self.tint[k] * 0.75 * strength).T)


class Rings:
    """slow ripples spreading from the middle, like the rings in the edit - barely there."""

    def __init__(self, w, h, cell):
        ys, xs = np.mgrid[0:h, 0:w]
        self.d = np.hypot(xs + 0.5 - w / 2, (ys + 0.5 - h / 2) * cell)
        self.reach = self.d.max()

    def draw(self, scr, t, strength=1.0):
        edge = np.clip((self.d / self.reach - 0.2) / 0.25, 0, 1)            # keep the middle clear for the words
        on = (((self.d - t * 2.2) % 10.0) < 0.9) & (edge > 0.05) & (scr.ch == " ") & (scr.bg == 0)
        scr.ch[on] = "·"
        fade = np.clip(1 - self.d[on] / self.reach, 0, 1) * edge[on] * strength
        scr.fg[on] = pack(WINE[:, None] * (0.45 + 0.9 * fade))


class Dust:
    """the card letting go: every letter becomes a bit of glitter flying outward."""

    def __init__(self, scr, box, cell):
        x, y, w, h = box
        ch, fg = scr.ch[y: y + h, x: x + w], scr.fg[y: y + h, x: x + w]
        ys, xs = np.nonzero(ch != " ")
        rng = np.random.default_rng(8)
        self.ch, self.fg = ch[ys, xs], fg[ys, xs]
        self.x, self.y = (xs + x).astype(float), (ys + y).astype(float)
        dx, dy = self.x - (x + w / 2), (self.y - (y + h / 2)) * cell
        dist = np.hypot(dx, dy) + 1e-3
        speed = rng.uniform(10, 34, len(xs))
        self.vx = dx / dist * speed + rng.normal(0, 4, len(xs))
        self.vy = dy / dist * speed / cell - rng.uniform(1, 5, len(xs))
        self.life = rng.uniform(0.45, 0.95, len(xs))

    def draw(self, scr, age):
        fade = np.clip(1 - age / self.life, 0, 1)
        x, y = (self.x + self.vx * age).astype(int), (self.y + self.vy * age).astype(int)
        on = (fade > 0) & (x >= 0) & (x < scr.w) & (y >= 0) & (y < scr.h)
        glyph = np.where(fade > 0.6, self.ch, np.where(fade > 0.3, "*", "."))
        scr.ch[y[on], x[on]] = glyph[on]
        scr.fg[y[on], x[on]] = fade_ink(self.fg[on], fade[on])


def fade_ink(c, f):
    """packed colours, each scaled by its own amount."""
    return (((c >> 16 & 255) * f).astype(np.int32) << 16 | ((c >> 8 & 255) * f).astype(np.int32) << 8
            | ((c & 255) * f).astype(np.int32))


# ── the show: garden on one side, the edit on the other ─────────────────────
class Stage:
    """the garden and the edit side by side (or stacked), a title above and the song below."""

    def __init__(self, W, H, cell, colours, aspect):
        self.scr, self.cell, self.W, self.H = Screen(W, H, colours), cell, W, H
        body = H - 2                                             # row 0: title, last row: the song
        if aspect is None:                                       # no video: the garden gets it all
            self.garden, self.edit = (0, 1, W, body), None
        elif W >= body * cell * 1.8:
            half = W // 2
            self.garden, self.edit = (0, 1, half, body), (half, 1, W - half, body)
        else:
            half = body // 2
            self.garden, self.edit = (0, 1, W, half), (0, 1 + half, W, body - half)
        self.view = View(*self.garden, cell, room=(1, 1))
        self.video = self.card = None
        if self.edit:
            ex, ey, ew, eh = self.edit
            vh = max(2, min(eh - 1, int((ew - 2) / (aspect * cell))))
            vw = max(2, min(ew - 2, int(vh * aspect * cell)))
            self.video = (ex + (ew - vw) // 2, ey + (eh - vh) // 2, vw, vh)
        self.card = Poster(*(self.edit or self.garden), prompt="r again   q close")

    def compose(self, garden, sky, stars, ink, frame, t, spin, length, ended, petals=None, dt=0.0):
        scr, (gx, gy, gw, gh) = self.scr, self.garden
        scr.clear()
        pts, tips = garden.points(t, self.view.res)
        depth = self.view.draw(scr, pts, t, spin, "letters")
        moon(scr, gx, gy, gw, gh, self.cell)
        stars.draw(scr, 0, 0, self.W, self.H, t)
        if petals is not None:                                   # the card's petals keep falling
            petals.draw(scr, t, dt, strength=0.6)
        if frame is not None and self.video and t >= CARD_AT and os.path.isfile(SIGNATURE):
            self._signature(scr, t - CARD_AT)                    # the edit signs off: your @, big
        elif frame is not None and self.video:                  # the edit, as glyph art
            vx, vy, vw, vh = self.video
            half = np.add(frame[:, 0::2, 0::2], frame[:, 1::2, 0::2], dtype=np.uint16)
            half += frame[:, 0::2, 1::2]
            half += frame[:, 1::2, 1::2]
            glyph, fg = ink(to_cells(half, 2, 4, 1 / (4 * 255)), frame)
            scr.ch[vy: vy + vh, vx: vx + vw] = CHARS[glyph].reshape(vh, vw)
            scr.fg[vy: vy + vh, vx: vx + vw] = dim(fg, min(1.0, t / 0.8)).reshape(vh, vw)
        elif ended is not None:                                  # the song is over: the card again
            self.card.draw(scr, ended)
        sky.draw(scr, self.view, depth, t, spin)
        self._title(scr, t)
        self._song(scr, t, length, ended)
        return tips

    def _signature(self, scr, age):
        """the closing card, readable: the name bounces up into place and settles, like in the edit."""
        vx, vy, vw, vh = self.video
        art = word_art(max(12, int(vw * 0.9)), SIGNATURE)
        if art is None:
            return
        glyph, cover = art
        rows, cols = glyph.shape
        bounce = 0.23 * vh * math.exp(-6.3 * age) * math.cos(TAU * age / 0.35)
        x0, y0 = vx + (vw - cols) // 2, vy + (vh - rows) // 2 + int(round(bounce))
        ys, xs = np.nonzero(glyph > 0)
        fx = xs / max(cols - 1, 1)
        colour = (HOT[:, None] * (1 - fx * 0.85) + BLUSH[:, None] * fx * 0.85) * (0.62 + 0.38 * cover[ys, xs])
        colour *= min(1.0, age / 0.15)
        cy, cx = y0 + ys, x0 + xs
        ok = (cy >= vy) & (cy < vy + vh) & (cx >= vx) & (cx < vx + vw)
        scr.ch[cy[ok], cx[ok]] = CHARS[glyph[ys[ok], xs[ok]]]
        scr.fg[cy[ok], cx[ok]] = pack(np.clip(colour[:, ok], 0, 1))

    def _title(self, scr, t):
        text = "i grew some flowers for you"
        text = f"·   {spaced(text)}   ·" if len(spaced(text)) + 8 < self.W else text
        n = int(np.clip(t / 1.6, 0, 1) * len(text))
        scr.put((self.W - len(text)) // 2, 0, text[:n], ink_of(ROSE, 0.85 + 0.15 * math.sin(t * 0.9)))

    def _song(self, scr, t, length, ended):
        if not length:
            return
        def clock(s):                                            # noqa: E306
            s = int(max(0, s))
            return f"{s // 60}:{s % 60:02d}"
        played = min(t, length)
        left, right = f"♪  {clock(played)}  ", f"  {clock(length)}"
        bar = max(10, min(56, self.W - len(left) - len(right) - 8))
        x = (self.W - len(left) - bar - len(right)) // 2
        done = int(round(bar * played / length))
        y = self.H - 1
        scr.put(x, y, left, ink_of(ROSE, 0.9))
        scr.put(x + len(left), y, "━" * done, ink_of(HOT, 0.9))
        scr.put(x + len(left) + done, y, "─" * (bar - done), ink_of(WINE, 1.2))
        if done < bar:
            scr.put(x + len(left) + done, y, "•", ink_of(BLUSH))
        scr.put(x + len(left) + bar, y, right, ink_of(MIST, 0.55))


def main():
    ap = argparse.ArgumentParser(description="i grew some flowers for you")
    ap.add_argument("--mute", action="store_true", help="no sound")
    ap.add_argument("--cell", type=float, default=2.0, help="height / width of one terminal cell")
    ap.add_argument("--colours", "--colors", choices=("auto", "24", "256"), default="auto")
    ap.add_argument("--autostart", type=float, metavar="SECONDS",
                    help="begin by itself this long after the card appears (handy for screen recording)")
    args = ap.parse_args()

    if os.path.isfile(BAKED):                                   # the sendable .exe: all decoded already
        with np.load(BAKED) as npz:
            fps, length, aspect = (float(x) for x in npz["meta"])
        sound = Tune(TUNE) if not args.mute else None

        def reel(size, start):
            return Baked(BAKED, size, start, fps)
    elif os.path.isfile(SONG):                                  # from this folder: ffmpeg reads the mp4
        ff = find_ffmpeg()
        video = Video(ff, SONG)
        length, aspect = video.duration, video.aspect
        sound = Sound(ff, SONG, 0.0) if video.audio and not args.mute else None   # ready while the card shows

        def reel(size, start):
            return Frames(ff, SONG, size, FPS, start)
    else:                                                       # no song at all: just the garden
        reel, sound, length, aspect = None, None, 0.0, None
    video = reel is not None

    if os.name == "nt" and getattr(sys, "frozen", False) and not os.environ.get("WT_SESSION"):
        cols, rows = Terminal.size()
        if cols < 130 or rows < 38:                             # a roomier window for the .exe
            os.system("mode con: cols=130 lines=38")
    term, colours = Keys(), Terminal.colours(args.colours)
    stars, rng = Stars(), np.random.default_rng()
    scene, size, frames = "card", None, None
    try:
        term.open()
        term.write("\x1b]0;for you\x07")
        start = last = time.perf_counter()
        while not term.dead:
            key = term.key()
            if key.lower() in ("q", "\x1b", "\x03"):
                break
            now = time.perf_counter()
            dt, last = min(now - last, 0.1), now

            if term.size() != size:                              # (re)build everything for this window
                size = term.size()
                W, H = size
                scr = Screen(W, H, colours)
                poster, petals, rings = Poster(0, 0, W, H), Petals(W, H), Rings(W, H, args.cell)
                stage = Stage(W, H, args.cell, colours, aspect)
                term.write("\x1b[0m\x1b[2J")
                if video and scene != "show":
                    if frames:
                        frames.close()
                    vx, vy, vw, vh = stage.video
                    frames = reel((vw * 4, vh * 8), 0.0)               # warm up while the card shows

            if scene == "card":
                if key in ("\r", "\n") or (args.autostart is not None and now - start > args.autostart):
                    scene, left = "leaving", now
                    scr.clear()
                    poster.draw(scr, 99.0)
                    dust = Dust(scr, (0, 0, W, H), args.cell)
                t = now - start
                scr.clear()
                rings.draw(scr, t)
                stars.draw(scr, 0, 0, W, H, t)
                petals.draw(scr, t, dt)
                poster.draw(scr, t)
                term.write(scr.flush())

            elif scene == "leaving":                             # a glitch, then glitter
                age, t = now - left, now - start
                scr.clear()
                stars.draw(scr, 0, 0, W, H, t)
                petals.draw(scr, t, dt, strength=max(0.0, 1 - age))
                if age < 0.45:
                    rings.draw(scr, t, strength=1 - age / 0.45)
                    poster.draw(scr, 99.0, shake=0.5 + age, rng=rng)
                else:
                    dust.draw(scr, age - 0.45)
                term.write(scr.flush())
                if age > 1.45:
                    scene, show, garden, sky, ink = "show", now, Garden(), Sky(), Ink()
                    spin = speed = 0.0
                    chosen, ended = SPIN, None
                    if sound:
                        sound.play()

            else:                                                # the show
                t = now - show
                if key in ("up", "+", "="):
                    chosen = min(1.5, round(chosen + 0.04, 2))
                if key in ("down", "-", "_"):
                    chosen = max(0.0, round(chosen - 0.04, 2))
                if key.lower() == "r":                           # from the very beginning
                    if sound:
                        sound.stop()
                    if frames:
                        frames.close()
                    vx, vy, vw, vh = stage.video or (0, 0, 1, 1)
                    frames = reel((vw * 4, vh * 8), 0.0) if video else None
                    show, t, garden, sky, ended, spin, speed = now, 0.0, Garden(), Sky(), None, 0.0, 0.0
                    if sound:
                        sound.play()
                if frames and stage.video and (frames.w, frames.h) != (stage.video[2] * 4, stage.video[3] * 8):
                    frames.close()                                # the window changed mid-song
                    frames = reel((stage.video[2] * 4, stage.video[3] * 8), t)
                frame = None
                if frames and ended is None:
                    frame = frames.get(max(frames.first, int(t * FPS)))
                    if frame is None or t >= length:
                        ended, frame = t, None
                target = chosen if t > garden.done + 0.4 else 0.0
                speed += (target - speed) * min(1.0, dt * 1.5)
                spin += speed * TAU * dt
                tips = stage.compose(garden, sky, stars, ink, frame, t, spin, length,
                                     None if ended is None else t - ended, petals, dt)
                sky.sparkle(tips, dt)
                term.write(stage.scr.flush())

            wait = 1 / FPS - (time.perf_counter() - now)
            if wait > 0:
                time.sleep(wait)
    except KeyboardInterrupt:
        pass
    finally:
        term.close()
        if frames:
            frames.close()
        if sound:
            sound.close()


if __name__ == "__main__":
    main()
