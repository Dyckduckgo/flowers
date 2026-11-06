#!/usr/bin/env python3
"""
art.py - plays a video as living ASCII art, right inside the terminal.

    python art.py                   plays the edit from this folder (the copy sign.py signed, if it's there)
    python art.py clip.mp4          ...or any other video
    python art.py --look pixels     sharp colour pixels instead of glyphs
    python art.py --no-code         just the art, no code pane

keys while it runs:   q quit    m switch look    c show / hide the code

needs numpy + ffmpeg:   pip install numpy imageio-ffmpeg
best in a 24-bit colour terminal: Windows Terminal, VS Code, iTerm2, kitty, WezTerm
"""

from __future__ import annotations

import argparse
import builtins
import io
import keyword
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tokenize

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
EDIT = next((p for p in (os.path.join(HERE, "feelings_for_you.mp4"), os.path.join(HERE, "feelings.mp4"))
             if os.path.isfile(p)), os.path.join(HERE, "feelings.mp4"))      # the signed copy (sign.py) first
SX, SY = 4, 8           # every terminal cell samples a 4 x 8 patch of the frame
CROP = 0.97             # trim a hair off the edges (edits often carry a 1px border)


# ── glyphs ──────────────────────────────────────────────────────────────────
# how much of each of the 4x8 sub-cells a character covers (0-f), measured
# from a monospace font. matching the picture against these is what puts a
# "/" on a slanted edge, a "_" on a floor and an "@" in solid ink.
GLYPHS = [
    (" ", "00000000000000000000000000000000"),
    ("`", "15000310000000000000000000000000"),
    (".", "00000000000000000530053000000000"),
    ("'", "03300650011000000000000000000000"),
    ("-", "00000000000019900000000000000000"),
    (":", "00000000076000000330043000000000"),
    ("_", "00000000000000000000000088880000"),
    (",", "00000000000000000430057028200000"),
    ('"', "15502990011000000000000000000000"),
    ("^", "01100870546300000000000000000000"),
    ("~", "00000000110089691041000000000000"),
    (";", "00000000076000000430058018200000"),
    ("<", "00000020058049000760004000000000"),
    (">", "00001200184000930760240000000000"),
    ("!", "03200650054005400320043000000000"),
    ("=", "00000000355223314884000000000000"),
    ("/", "00220080017007200900540030000000"),
    ("*", "02203992388202200000000000000000"),
    ("\\", "32002800091003600080006300120000"),
    ("+", "0000000005407bb60540022000000000"),
    ("?", "072001a1029209300500061000000000"),
    ("|", "05400540054005400540054005400000"),
    (")", "06000740009000900090036009000000"),
    ("(", "005004600a000a000b00083001800000"),
    ("]", "07500080008000800080008007900000"),
    ("7", "23314797008102800920160000000000"),
    ("}", "26100450026000b30260036029300000"),
    ("{", "0161063007204b000820072004910000"),
    ("[", "06600a000a000a000a000a000b600000"),
    ("#", "011009615bb6388168a3224000000000"),
    ("8", "02105894578339a29247287100000000"),
    ("%", "45057963677008754579507400000000"),
    ("0", "011049a390899a3a8456187000000000"),
    ("$", "00504ab1875009b218575c7004000000"),
    ("&", "174064904b60887891b6395700000000"),
    ("@", "04615418758879888998754256600000"),
]
RAMP = " .-:;~=*+?{[#8%0$&@"   # the glyphs that read as an even tone, light to dense

CHARS = np.array([c for c, _ in GLYPHS])
SHAPE = np.array([[int(d, 16) / 15 for d in bits] for _, bits in GLYPHS], np.float32)
SHAPE_E = (SHAPE ** 2).sum(1)
COVER = SHAPE.mean(1)
_ramp = np.array([CHARS.tolist().index(c) for c in RAMP])
TONE = _ramp[np.abs(COVER[_ramp][None, :] - np.linspace(0, COVER.max(), 256)[:, None]).argmin(1)]


# ── colours ─────────────────────────────────────────────────────────────────
def rgb(r, g, b):
    return (r << 16) | (g << 8) | b


C_TEXT, C_KEYWORD, C_FUNC = rgb(206, 206, 214), rgb(255, 95, 140), rgb(255, 186, 112)
C_STRING, C_NUMBER, C_COMMENT = rgb(150, 214, 160), rgb(186, 152, 255), rgb(104, 104, 118)
C_OP, C_NAME, C_LINENO = rgb(150, 150, 162), rgb(120, 196, 255), rgb(72, 72, 84)
C_HILITE, C_BAR, C_HUD = rgb(46, 10, 22), rgb(255, 70, 122), rgb(150, 150, 162)
C_PINK, C_RULE, C_STATUS = rgb(255, 92, 138), rgb(30, 30, 38), rgb(196, 196, 204)
BUILTINS = set(dir(builtins)) | {"self", "np"}


def pack(c):
    """float rgb, channels first (3, ...) -> one int per colour, 32 steps a channel."""
    q = np.minimum(255, ((np.clip(c, 0, 1) * 255).astype(np.int32) + 4) >> 3 << 3)
    return (q[0] << 16) | (q[1] << 8) | q[2]


def dim(c, f):
    """scale packed colour(s) towards black."""
    if f >= 1:
        return c
    c = np.asarray(c)
    return (((c >> 16 & 255) * f).astype(np.int32) << 16 | ((c >> 8 & 255) * f).astype(np.int32) << 8
            | ((c & 255) * f).astype(np.int32))


# ── the art ─────────────────────────────────────────────────────────────────
# each terminal cell looks at its own patch of the frame. we find the colour of
# the page, wipe it to black, and redraw whatever is left as glyphs: solid ink
# becomes dense letters, edges get the glyph whose shape fits them best.
# tone and colour come from a quick 2x4 sample of every cell; only the cells
# that hold an edge are looked at closely (4x8) to pick the glyph's shape.
def smoothstep(a, b, x):
    t = np.clip((x - a) * (1 / (b - a)), 0.0, 1.0)
    s = t * t
    t *= -2
    t += 3
    s *= t
    return s


def page_colour(r, g, b):
    """the most common colour in the frame - the paper everything sits on."""
    key = ((r * 15.99).astype(np.int32) << 8) | ((g * 15.99).astype(np.int32) << 4) | (b * 15.99).astype(np.int32)
    counts = np.bincount(key.ravel(), minlength=4096)
    top = counts.argmax()
    hit = key == top
    return (r[hit].mean(), g[hit].mean(), b[hit].mean()), float(counts[top] / key.size)


def glow(colour, pop):
    """lift colours so they shine on black; dark ink from a light page turns bright."""
    v = colour.max(0)
    target = 0.42 + 0.58 * np.maximum(v, pop) ** 0.8
    gain = target / np.maximum(v, 0.12)
    out = colour * gain + np.maximum(0.0, target - v * gain)
    grey = out.mean(0)
    return np.clip(grey + (out - grey) * 1.25, 0.0, 1.0)


class Ink:
    """the rose look: the page goes black and everything on it turns to glyphs."""

    def __init__(self):
        self.graphic = 1.0       # 1 = flat graphic frame, 0 = photo (smoothed)
        self.grain = self.page = self.span = None

    def coverage(self, R, G, B):
        """how much ink each sample holds (0-1), and how far it sits from the page colour."""
        g, p, dist = self.graphic, None, None
        if g > 0.02:                                  # graphics: whatever isn't page
            dr, dg, db = R - self.page[0], G - self.page[1], B - self.page[2]
            dist = np.sqrt(dr * dr + dg * dg + db * db)
            p = smoothstep(0.08, 0.55, dist)          # faint tints stay light, bold ink goes dense
        if g < 0.98:                                  # photos: light becomes density
            lo, hi = self.span
            shade = np.clip((0.299 * R + 0.587 * G + 0.114 * B - lo) * (1 / (hi - lo)), 0.0, 1.0)
            p = shade if p is None else g * p + (1 - g) * shade
        return p, dist

    def __call__(self, small, full):
        R, G, B = small                               # (8, cells): a 2x4 sample of every cell
        n = R.shape[1]
        if self.grain is None or len(self.grain) != n:
            self.grain = np.random.default_rng(22).uniform(0.72, 1.0, n).astype(np.float32)
        self.page, share = page_colour(R[::2, ::2], G[::2, ::2], B[::2, ::2])
        self.graphic += (float(smoothstep(0.10, 0.28, share)) - self.graphic) * 0.5
        if self.graphic < 0.98:
            lum = (0.299 * R[::3] + 0.587 * G[::3] + 0.114 * B[::3]).ravel()
            k = len(lum) // 50
            lo, hi = (float(v) for v in np.partition(lum, (k, len(lum) - 1 - k))[[k, len(lum) - 1 - k]])
            self.span = (lo, max(hi, lo + 0.05))
        p, dist = self.coverage(R, G, B)

        total = p.sum(0)
        mean = total * (1 / len(p))
        glyph = TONE[np.clip(mean * self.grain * 255, 0, 255).astype(np.int32)]
        edge = np.flatnonzero((p * p).sum(0) * (1 / len(p)) - mean * mean > 0.03)   # cells holding an outline
        if len(edge):
            cols = full.shape[2] // SX
            er, ec = np.divmod(edge, cols)
            patch = full.reshape(3, -1, SY, cols, SX)[:, er, :, ec, :]       # (edges, 3, 8, 4)
            fine = patch.transpose(1, 2, 3, 0).reshape(3, SY * SX, len(edge)) * np.float32(1 / 255)
            P, _ = self.coverage(fine[2], fine[0], fine[1])                  # planes come as g, b, r
            glyph[edge] = (SHAPE_E[:, None] - 2 * SHAPE @ (0.82 * P)).argmin(0)

        w = p + 0.02
        colour = np.stack([(R * w).sum(0), (G * w).sum(0), (B * w).sum(0)]) / w.sum(0)
        pop = 0.0
        if dist is not None:
            pop = self.graphic * np.clip((dist * p).sum(0) / np.maximum(total, 1e-3) * 2, 0, 1)
        return glyph, pack(glow(colour, pop))


def pixels(small):
    """the hi-fi look: '▀' with the top half as ink and the bottom half as paper."""
    half = small.shape[1] // 2
    return pack(small[:, :half].mean(1)), pack(small[:, half:].mean(1))


def to_cells(planes, sx, sy, scale=1 / 255):
    """ffmpeg's planar (g, b, r) values -> (3, sx*sy, rows*cols) floats in r, g, b order:
    every cell's patch as a column, one plane per channel (numpy likes it that way round)."""
    _, h, w = planes.shape
    r, c = h // sy, w // sx
    out = np.empty((3, sy, sx, r, c), np.float32)
    for dst, src in ((0, 2), (1, 0), (2, 1)):
        patch = planes[src, : r * sy, : c * sx].reshape(r, sy, c, sx).transpose(1, 3, 0, 2)
        np.multiply(patch, np.float32(scale), out=out[dst])
    return out.reshape(3, sy * sx, r * c)


def area_mean(a, h, w):
    """box-filter a picture down to h x w (every output pixel is the mean of its patch)."""
    H, W = a.shape
    ys, xs = np.linspace(0, H, h + 1).astype(int), np.linspace(0, W, w + 1).astype(int)
    c = np.pad(a.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    total = (c[ys[1:, None], xs[None, 1:]] - c[ys[:-1, None], xs[None, 1:]]
             - c[ys[1:, None], xs[None, :-1]] + c[ys[:-1, None], xs[None, :-1]])
    return total / np.maximum((ys[1:] - ys[:-1])[:, None] * (xs[1:] - xs[:-1])[None, :], 1)


class Signature:
    """your @ (signature.npz, made by sign.py), drawn big when the edit reaches its closing card.
    at glyph size the card's own lettering is a smudge, so the name is set in big glyph letters
    and moves exactly as the card does: up from below, two flashes, a bounce, then it settles."""

    HOT, BLUSH = np.array([255, 64, 129]) / 255, np.array([255, 196, 214]) / 255

    def __init__(self, path):
        with np.load(path) as z:
            self.alpha = z["alpha"] / 255.0
            self.name = str(z["name"])
            self.start = float(z["start"]) if "start" in z.files else 37.27     # when the card comes up
            self.track = z["track"] if "track" in z.files else np.zeros((1, 3))  # seconds, offset, flash
        self.tall = self.alpha.shape[0] / self.alpha.shape[1]
        self.cache = {}

    def glyphs(self, cols):
        if cols not in self.cache:
            rows = max(2, round(cols * self.tall / 2))                    # cells are twice as tall as wide
            cells = area_mean(self.alpha, rows * SY, cols * SX).reshape(rows, SY, cols, SX)
            cells = cells.transpose(0, 2, 1, 3).reshape(rows * cols, SY * SX)
            glyph = TONE[np.clip(cells.mean(1) * 255, 0, 255).astype(int)]
            glyph[cells.mean(1) > 0.85] = CHARS.tolist().index("@")      # solid strokes: one steady letter
            edge = cells.std(1) > 0.2
            glyph[edge] = (SHAPE_E - 2 * (0.82 * cells[edge]) @ SHAPE.T).argmin(1)
            self.cache[cols] = (glyph.reshape(rows, cols), cells.mean(1).reshape(rows, cols))
        return self.cache[cols]

    def draw(self, scr, box, age):
        x0, y0, w, h = box
        scr.ch[y0: y0 + h, x0: x0 + w], scr.fg[y0: y0 + h, x0: x0 + w], scr.bg[y0: y0 + h, x0: x0 + w] = " ", 0, 0
        glyph, cover = self.glyphs(max(12, min(int(w * 0.92), int(h * 1.1 / self.tall))))
        rows, cols = glyph.shape
        i = int(np.clip(np.searchsorted(self.track[:, 0], age, "right") - 1, 0, len(self.track) - 1))
        _, off, flash = self.track[i]
        x, y = x0 + (w - cols) // 2, y0 + (h - rows) // 2 + int(round(off / CROP * h))
        ys, xs = np.nonzero(glyph > 0)
        fx = xs / max(cols - 1, 1)
        if flash:                                                # the card's flashes: white-hot
            colour = np.tile((self.BLUSH * 0.4 + 0.6)[:, None], len(xs))
        else:
            colour = (self.HOT[:, None] * (1 - fx * 0.85) + self.BLUSH[:, None] * fx * 0.85) * (0.62 + 0.38 * cover[ys, xs])
            band = ((age - 1.0) * 0.4) % 2.2 - 0.4               # once it has settled, a slow shine
            colour = colour + 0.33 * np.exp(-((fx - band + 0.15 * ys / max(rows - 1, 1)) / 0.05) ** 2) * (age > 1.0)
        cy, cx = y + ys, x + xs
        ok = (cy >= y0) & (cy < y0 + h) & (cx >= x0) & (cx < x0 + w)
        scr.ch[cy[ok], cx[ok]] = CHARS[glyph[ys[ok], xs[ok]]]
        scr.fg[cy[ok], cx[ok]] = pack(np.clip(colour[:, ok] * min(1.0, 0.55 + age / 0.2), 0, 1))


class Stars:
    """a slow twinkle in the empty black, like the sky behind the rose."""

    TINTS = np.array([[1.0, 1.0, 1.0], [1.0, 0.78, 0.88], [0.78, 0.86, 1.0]], np.float32)

    def __init__(self):
        self.size = None

    def place(self, w, h):
        rng = np.random.default_rng(5)
        n = max(8, w * h // 55)
        self.x, self.y = rng.integers(0, w, n), rng.integers(0, h, n)
        self.phase, self.speed = rng.uniform(0, 6.283, n), rng.uniform(0.5, 2.2, n)
        tint = self.TINTS[rng.integers(0, 3, n)].T[:, :, None]          # (3, stars, 1)
        steps = np.arange(7, dtype=np.float32) / 6                       # brightness in 7 steps
        self.colour = pack(tint * (0.18 + 0.72 * steps))                 # (stars, 7)
        self.glint = np.flatnonzero(rng.random(n) < 0.1)
        self.arm = pack(tint[:, self.glint, 0] * 0.35)
        self.size = (w, h)

    def draw(self, scr, x0, y0, w, h, t):
        if self.size != (w, h):
            self.place(w, h)
        step = np.rint((0.5 + 0.5 * np.sin(self.speed * t + self.phase)) * 6).astype(np.int32)
        xs, ys = self.x + x0, self.y + y0
        lit = (step >= 3) & (scr.ch[ys, xs] == " ") & (scr.bg[ys, xs] == 0)
        s = step[lit]
        scr.ch[ys[lit], xs[lit]] = np.where(s == 6, "*", np.where(s == 5, "+", "."))
        scr.fg[ys[lit], xs[lit]] = self.colour[lit, s]
        for k in np.flatnonzero(lit[self.glint] & (step[self.glint] == 6)).tolist():   # a cross of light
            x, y = int(xs[self.glint[k]]), int(ys[self.glint[k]])
            for dx, dy, c in ((-1, 0, "-"), (1, 0, "-"), (0, -1, "|"), (0, 1, "|")):
                xx, yy = x + dx, y + dy
                if x0 <= xx < x0 + w and y0 <= yy < y0 + h and scr.ch[yy, xx] == " " and not scr.bg[yy, xx]:
                    scr.ch[yy, xx], scr.fg[yy, xx] = c, self.arm[k]


# ── the code pane ───────────────────────────────────────────────────────────
class Code:
    """types this very file out, line by line, while the art plays."""

    def __init__(self, path, cps):
        try:
            with open(path, encoding="utf-8") as f:
                src = f.read()
        except OSError:
            src = ""
        self.lines = src.split("\n")
        self.paint = [np.full(len(line), C_TEXT, np.int32) for line in self.lines]
        self._highlight(src)
        self.starts = np.cumsum([0] + [len(line) + 1 for line in self.lines])
        self.total = max(1, int(self.starts[-1]))
        mark = next((i for i, line in enumerate(self.lines) if line.startswith("# ── the art")), 0)
        self.begin, self.cps = int(self.starts[mark]), cps

    def _highlight(self, src):
        strings = {tokenize.STRING} | {getattr(tokenize, k) for k in (
            "FSTRING_START", "FSTRING_MIDDLE", "FSTRING_END",
            "TSTRING_START", "TSTRING_MIDDLE", "TSTRING_END") if hasattr(tokenize, k)}
        prev = ""
        try:
            for tok in tokenize.generate_tokens(io.StringIO(src).readline):
                kind, text, colour = tok.type, tok.string, None
                if kind == tokenize.COMMENT:
                    colour = C_COMMENT
                elif kind in strings:
                    colour = C_STRING
                elif kind == tokenize.NUMBER:
                    colour = C_NUMBER
                elif kind == tokenize.OP:
                    colour = C_OP
                elif kind == tokenize.NAME:
                    colour = (C_KEYWORD if keyword.iskeyword(text) else C_FUNC if prev in ("def", "class")
                              else C_NAME if text in BUILTINS else None)
                if kind in (tokenize.NAME, tokenize.OP):
                    prev = text
                if colour is not None:
                    (r0, c0), (r1, c1) = tok.start, tok.end
                    for r in range(r0, r1 + 1):
                        line = self.paint[r - 1]
                        line[c0 if r == r0 else 0: c1 if r == r1 else len(line)] = colour
        except (tokenize.TokenError, SyntaxError, IndexError):
            pass

    def draw(self, scr, x, y, w, h, t):
        if w < 14 or h < 1:
            return
        pos = (self.begin + int(t * self.cps)) % self.total
        line = int(np.searchsorted(self.starts, pos, side="right")) - 1
        col = pos - int(self.starts[line])
        top, cx, room = line - int(h * 0.62), x + 7, w - 8
        for r in range(h):
            n = top + r
            if n < 0 or n > line:
                continue
            here, row = n == line, y + r
            bg = C_HILITE if here else 0
            fade = min(1.0, (r + 1) / 4)                    # older lines melt into the dark
            if here:
                scr.fill(x, row, w, bg)
                scr.put(x, row, "▌", C_BAR, bg)
            scr.put(x + 1, row, f"{n + 1:>4}", C_BAR if here else dim(C_LINENO, fade), bg)
            text = self.lines[n][: col if here else None][:room]
            if text:
                scr.put(cx, row, text, dim(self.paint[n][: len(text)], fade), bg)
            if here:
                scr.put(min(cx + len(text), x + w - 1), row, " ", 0, C_BAR)   # the cursor


# ── the screen ──────────────────────────────────────────────────────────────
def near(a, b, tol=24):
    """packed colours within a small step of each other."""
    d = np.abs((a >> 16 & 255) - (b >> 16 & 255))
    d += np.abs((a >> 8 & 255) - (b >> 8 & 255))
    d += np.abs((a & 255) - (b & 255))
    return d <= tol


CUBE = np.array([0, 95, 135, 175, 215, 255])
EDGES = np.array([47, 115, 155, 195, 235])


def xterm256(c):
    """packed rgb -> the nearest of the 256 classic terminal colours (a 6x6x6 cube + 24 greys)."""
    r, g, b = c >> 16 & 255, c >> 8 & 255, c & 255
    ri, gi, bi = np.searchsorted(EDGES, r), np.searchsorted(EDGES, g), np.searchsorted(EDGES, b)
    level = np.clip(((r + g + b) // 3 - 3) // 10, 0, 23)
    v = 8 + 10 * level
    off_cube = (r - CUBE[ri]) ** 2 + (g - CUBE[gi]) ** 2 + (b - CUBE[bi]) ** 2
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    off_grey = np.where(chroma < 40, (r - v) ** 2 + (g - v) ** 2 + (b - v) ** 2, 1 << 30)   # greys only for greys
    return np.where(off_grey < off_cube, 232 + level, 16 + 36 * ri + 6 * gi + bi)


class Screen:
    """a grid of (glyph, ink, paper). only the cells that changed get re-sent."""

    def __init__(self, w, h, colours=24):
        self.w, self.h, self.colours = w, h, colours
        self.ch = np.full((h, w), " ", dtype="<U1")
        self.fg = np.zeros((h, w), np.int32)
        self.bg = np.zeros((h, w), np.int32)
        self.prev = None

    def clear(self):
        self.ch[:], self.fg[:], self.bg[:] = " ", 0, 0

    def put(self, x, y, text, fg, bg=None):
        if not 0 <= y < self.h or x >= self.w or x < 0:
            return
        text = text[: self.w - x]
        n = len(text)
        self.ch[y, x: x + n] = list(text)
        self.fg[y, x: x + n] = fg if np.ndim(fg) == 0 else fg[:n]
        if bg is not None:
            self.bg[y, x: x + n] = bg

    def fill(self, x, y, w, bg):
        if 0 <= y < self.h:
            self.ch[y, x: x + w], self.bg[y, x: x + w] = " ", bg

    def flush(self):
        """the escape codes that turn the last frame on screen into this one."""
        ch, fg, bg = self.ch, self.fg, self.bg
        if self.colours == 256:
            fg, bg = xterm256(fg), xterm256(bg)
        if self.prev is None:
            dirty = np.ones(ch.shape, bool)
        else:                                         # a colour that barely moved isn't worth resending
            pch, pfg, pbg = self.prev
            same_fg, same_bg = (near(fg, pfg), near(bg, pbg)) if self.colours == 24 else (fg == pfg, bg == pbg)
            dirty = (ch != pch) | ~same_bg | (~same_fg & (ch != " "))
            fg, bg = np.where(dirty, fg, pfg), np.where(dirty, bg, pbg)
        self.prev = (ch.copy(), fg.copy(), bg.copy())

        # runs of changed cells across the whole screen at once; gaps under 10 cells are
        # cheaper to resend than to jump over, so neighbouring runs on a row get merged
        edges = np.diff(np.pad(dirty, ((0, 0), (1, 1))).view(np.int8), axis=1)
        ys, a = np.nonzero(edges == 1)
        b = np.nonzero(edges == -1)[1]
        if not len(ys):
            return ""
        new = np.r_[True, (ys[1:] != ys[:-1]) | (a[1:] - b[:-1] > 10)]
        first = np.flatnonzero(new)
        last = np.r_[first[1:] - 1, len(ys) - 1]

        out, cf, cb = ["\x1b[?2026h"], -1, -1
        fgs, bgs = (FG_SGR, BG_SGR) if self.colours == 24 else (FG_256, BG_256)
        for y, x0, x1 in zip(ys[first].tolist(), a[first].tolist(), b[last].tolist()):
            out.append(f"\x1b[{y + 1};{x0 + 1}H")
            for c, f, k in zip(ch[y, x0:x1].tolist(), fg[y, x0:x1].tolist(), bg[y, x0:x1].tolist()):
                if k != cb:                                       # colour codes only on change
                    out.append(bgs.get(k) or bgs.setdefault(k, f"\x1b[48;2;{k >> 16};{k >> 8 & 255};{k & 255}m"))
                    cb = k
                if f != cf and c != " ":
                    out.append(fgs.get(f) or fgs.setdefault(f, f"\x1b[38;2;{f >> 16};{f >> 8 & 255};{f & 255}m"))
                    cf = f
                out.append(c)
        out.append("\x1b[?2026l")
        return "".join(out)


FG_SGR, BG_SGR = {}, {}          # escape codes we've already built, by colour
FG_256 = {i: f"\x1b[38;5;{i}m" for i in range(256)}
BG_256 = {i: f"\x1b[48;5;{i}m" for i in range(256)}


class Layout:
    """art on top and code below (tall windows), or side by side (wide ones)."""

    def __init__(self, W, H, aspect, code, cell):
        def fit(bw, bh):
            vw = max(1, min(bw, int(bh * aspect * cell)))
            vh = max(1, min(bh, int(vw / (aspect * cell) + 0.5)))
            return vw, vh

        options = []
        if code:
            hc = max(7, int(H * 0.36))
            if H - hc - 2 >= 10:
                options.append(((0, 0, W, H - hc - 2), (0, H - hc - 2, W), (0, H - hc, W, hc)))
            wc = min(max(44, int(W * 0.40)), W - 24)
            if wc >= 30:
                wa = W - wc - 1
                options.append(((0, 0, wa, H), (wa + 1, 0, wc), (wa + 1, 2, wc, H - 2)))
        if not options:
            options.append(((0, 0, W, H - 1), (0, H - 1, W), None))
        self.art, self.status, self.code = max(
            options, key=lambda o: np.prod(fit(o[0][2], max(1, o[0][3] - 4))))
        ax, ay, aw, ah = self.art
        vw, vh = fit(aw, max(1, ah - 4))
        self.video = (ax + (aw - vw) // 2, ay + 1 + (max(1, ah - 4) - vh) // 2, vw, vh)


# ── video, sound and the terminal ───────────────────────────────────────────
class Video:
    def __init__(self, ff, path):
        if not os.path.isfile(path):
            sys.exit(f"no such video: {path}")
        info = subprocess.run([ff, "-hide_banner", "-nostdin", "-i", path],
                              capture_output=True, text=True, errors="replace").stderr
        dur = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", info)
        size = re.search(r"Video:.*?,\s*(\d{2,5})x(\d{2,5})", info)
        if not (dur and size):
            sys.exit(f"ffmpeg could not read {path}")
        h, m, s = dur.groups()
        self.duration = int(h) * 3600 + int(m) * 60 + float(s)
        w, hh = int(size.group(1)), int(size.group(2))
        rot = re.search(r"rotation of (-?[\d.]+)", info)
        if rot and abs(round(float(rot.group(1)))) % 180 == 90:
            w, hh = hh, w
        self.aspect = w / hh
        self.audio = re.search(r"Stream #.*Audio:", info) is not None


class Frames:
    """ffmpeg decodes and scales; a thread hands the frames over as numpy arrays."""

    def __init__(self, ff, path, size, fps, start):
        self.w, self.h = size
        self.first = round(start * fps)
        vf = f"fps={fps},crop=iw*{CROP}:ih*{CROP},scale={self.w}:{self.h}:flags=area,format=gbrp"
        self.proc = subprocess.Popen(
            [ff, "-nostdin", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", path,
             "-an", "-vf", vf, "-f", "rawvideo", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.q, self.stop, self.ended = queue.Queue(maxsize=4), False, False
        self.cur, self.cur_i = None, self.first - 1
        threading.Thread(target=self._pump, daemon=True).start()

    def _put(self, item):
        while not self.stop:
            try:
                return self.q.put(item, timeout=0.1)
            except queue.Full:
                pass

    def _pump(self):
        n, i = 3 * self.w * self.h, self.first
        while not self.stop:
            buf = self.proc.stdout.read(n)
            if len(buf) < n:
                break
            self._put((i, np.frombuffer(buf, np.uint8).reshape(3, self.h, self.w)))
            i += 1
        self._put(None)

    def get(self, idx):
        """the newest frame at or before idx (late frames are skipped). None = the end."""
        while (self.cur is None or self.cur_i < idx) and not self.ended:
            try:                                      # ffmpeg can be slow to wake (virus scans...):
                item = self.q.get(timeout=0.25)       # only its closing the pipe means "the end"
            except queue.Empty:
                continue
            if item is None:
                self.ended = True
            else:
                self.cur_i, self.cur = item
        return None if self.ended and self.cur_i < idx else self.cur

    def close(self):
        self.stop = True
        self.proc.kill()
        self.proc.wait()


class Sound:
    """pulls the soundtrack out to a wav and plays it alongside the picture."""

    def __init__(self, ff, path, start):
        fd, self.wav = tempfile.mkstemp(prefix="art_", suffix=".wav")
        os.close(fd)
        self.extract = subprocess.Popen(                 # runs in the background while we set up
            [ff, "-nostdin", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", path,
             "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", self.wav],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ok, self.proc = None, None

    def ready(self):
        if self.ok is None:
            self.ok = self.extract.wait() == 0 and os.path.getsize(self.wav) > 1024
        return self.ok

    def play(self):
        if not self.ready():
            return
        if os.name == "nt":
            import winsound
            winsound.PlaySound(self.wav, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
            return
        for cmd in (["afplay"], ["paplay"], ["aplay", "-q"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]):
            if shutil.which(cmd[0]):
                self.proc = subprocess.Popen(cmd + [self.wav], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return

    def stop(self):
        if os.name == "nt" and self.ok:
            import winsound
            winsound.PlaySound(None, 0)
        if self.proc:
            self.proc.terminate()
            self.proc = None

    def close(self):
        if self.extract.poll() is None:
            self.extract.kill()
            self.extract.wait()
        self.stop()
        try:
            os.remove(self.wav)
        except OSError:
            pass


class Terminal:
    """raw terminal i/o. a writer thread feeds the console while the next frame is drawn."""

    def __init__(self):
        self.saved, self.dead = None, False
        self.q = queue.Queue(maxsize=1)
        threading.Thread(target=self._writer, daemon=True).start()

    def _writer(self):
        out = sys.stdout.buffer
        while True:
            data = self.q.get()
            try:
                if data is not None and not self.dead:
                    out.write(data)
                    out.flush()
            except (OSError, ValueError):             # the window went away
                self.dead = True
            finally:
                self.q.task_done()

    def write(self, s):
        data = s.encode("utf-8")
        while not self.dead:                          # short waits keep Ctrl+C working
            try:
                return self.q.put(data, timeout=0.1)
            except queue.Full:
                pass

    def drain(self, patience=3.0):
        end = time.perf_counter() + patience
        while self.q.unfinished_tasks and not self.dead and time.perf_counter() < end:
            time.sleep(0.005)

    def open(self):
        if os.name == "nt":
            import ctypes
            ctypes.windll.winmm.timeBeginPeriod(1)      # 1 ms sleeps, not 15.6 ms ticks
            k32 = ctypes.windll.kernel32
            out, mode = k32.GetStdHandle(-11), ctypes.c_uint32()
            if k32.GetConsoleMode(out, ctypes.byref(mode)):
                self.saved = (out, mode.value, k32.GetConsoleOutputCP())
                k32.SetConsoleMode(out, mode.value | 0x0001 | 0x0004)   # processed + VT sequences
                k32.SetConsoleOutputCP(65001)
        elif sys.stdin.isatty():
            import termios
            import tty
            self.saved = termios.tcgetattr(sys.stdin.fileno())
            tty.setcbreak(sys.stdin.fileno())
        self.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[0m\x1b[2J")

    def close(self):
        self.write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l")
        self.drain()
        if os.name == "nt":
            import ctypes
            ctypes.windll.winmm.timeEndPeriod(1)
            if self.saved:
                out, mode, cp = self.saved
                ctypes.windll.kernel32.SetConsoleMode(out, mode)
                ctypes.windll.kernel32.SetConsoleOutputCP(cp)
        elif self.saved is not None:
            import termios
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self.saved)

    @staticmethod
    def colours(choice):
        """24-bit colour everywhere it's fast. the classic Windows console chokes on it,
        and macOS Terminal.app can't show it, so those two get the 256-colour palette."""
        if choice != "auto":
            return int(choice)
        env = os.environ
        modern = env.get("WT_SESSION") or env.get("TERM_PROGRAM") or env.get("COLORTERM") in ("truecolor", "24bit")
        if (os.name == "nt" and not modern) or env.get("TERM_PROGRAM") == "Apple_Terminal":
            return 256
        return 24

    @staticmethod
    def size():
        w, h = shutil.get_terminal_size((100, 40))
        return max(20, w), max(10, h)

    def key(self):
        """the key pressed since last time, if any. arrows and F-keys are swallowed whole."""
        if os.name == "nt":
            import msvcrt
            if not msvcrt.kbhit():
                return ""
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):                # an arrow / F-key: a prefix plus a code letter
                msvcrt.getwch()
                return ""
            return ch
        if self.saved is not None:
            import select
            if select.select([sys.stdin], [], [], 0)[0]:
                ch = os.read(sys.stdin.fileno(), 1).decode(errors="ignore")
                if ch == "\x1b" and select.select([sys.stdin], [], [], 0.02)[0]:
                    os.read(sys.stdin.fileno(), 16)  # the tail of an arrow / F-key sequence
                    return ""
                return ch
        return ""


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import glob
    import importlib.util
    spec = importlib.util.find_spec("imageio_ffmpeg")    # its bundled binary, found without importing it
    if spec and spec.origin:
        for hit in glob.glob(os.path.join(os.path.dirname(spec.origin), "binaries", "ffmpeg*")):
            if os.path.isfile(hit) and not hit.endswith((".md", ".py", ".txt")):
                return hit
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        sys.exit("ffmpeg not found. install it with:   pip install imageio-ffmpeg")


# ── putting it together ─────────────────────────────────────────────────────
def compose(scr, lay, full, look, ink, stars, code, clock, t, info):
    """draw one whole frame (art, stars, HUD, status line, code) into the screen buffer."""
    scr.clear()
    vx, vy, vw, vh = lay.video
    half = np.add(full[:, 0::2, 0::2], full[:, 1::2, 0::2], dtype=np.uint16)
    half += full[:, 0::2, 1::2]
    half += full[:, 1::2, 1::2]
    cells = to_cells(half, SX // 2, SY // 2, 1 / (4 * 255))       # 2x2 average: a 2x4 sample per cell
    if look == "ascii":
        glyph, fg = ink(cells, full)
        scr.ch[vy: vy + vh, vx: vx + vw] = CHARS[glyph].reshape(vh, vw)
        scr.fg[vy: vy + vh, vx: vx + vw] = fg.reshape(vh, vw)
        drawn = int(np.count_nonzero(glyph))
    else:
        top, bottom = pixels(cells)
        scr.ch[vy: vy + vh, vx: vx + vw] = "▀"
        scr.fg[vy: vy + vh, vx: vx + vw] = top.reshape(vh, vw)
        scr.bg[vy: vy + vh, vx: vx + vw] = bottom.reshape(vh, vw)
        drawn = vw * vh
    sign = info.get("sign")
    if sign and t >= sign.start:                      # the closing card: your @, big enough to read
        sign.draw(scr, lay.video, t - sign.start)

    ax, ay, aw, ah = lay.art
    stars.draw(scr, ax, ay, aw, ah, clock)
    stamp = f" t {t:05.2f}s"
    scr.put(ax + aw - len(stamp) - 2, ay, "■", C_PINK)
    scr.put(ax + aw - len(stamp) - 1, ay, stamp, C_PINK)
    lines = (f"{info['tag']} · {time.localtime().tm_year}",
             f"frame {info['frame']:04d}/{info['frames']:04d}   played {100 * info['frame'] / info['frames']:5.1f}%",
             f"glyphs {drawn:,}   look {look}")
    for i, text in enumerate(lines):
        scr.put(ax + 1, ay + ah - 3 + i, text, C_HUD)

    sx, sy, sw = lay.status
    scr.put(sx, sy, f"$ py {info['script']}", C_STATUS)
    right = f"running · {info['fps']:.0f} fps"
    scr.put(sx + sw - len(right) - 1, sy, right, C_HUD)
    if lay.code:
        x, y, w, h = lay.code
        scr.put(x, y - 1, "─" * w, C_RULE)
        code.draw(scr, x, y, w, h, clock)


def play(args, ff, video, sound, term):
    fps = args.fps
    total = max(1, int((video.duration - args.start) * fps) + round(args.start * fps))
    sign_path = os.path.join(HERE, "signature.npz")
    sign = Signature(sign_path) if (os.path.isfile(sign_path) and not args.no_sign
                                    and os.path.basename(args.video).startswith("feelings")) else None
    info = {"tag": args.tag or (sign.name if sign else os.path.splitext(os.path.basename(args.video))[0]),
            "script": os.path.basename(sys.argv[0]) or "art.py", "frames": total, "fps": fps, "frame": 0,
            "sign": sign}
    look, show_code, colours = args.look, not args.no_code, Terminal.colours(args.colours)
    ink, stars, code = Ink(), Stars(), Code(os.path.abspath(__file__), args.cps)
    frames = scr = lay = size = clock0 = last = None
    shown = 0
    try:
        while not term.dead:
            key = term.key().lower()
            if key in ("q", "\x1b", "\x03"):
                break
            if key == "m":
                look = "pixels" if look == "ascii" else "ascii"
            if key == "c":
                show_code, size = not show_code, None

            if term.size() != size:                   # first frame, or the window changed size
                size = term.size()
                scr, lay = Screen(*size, colours), Layout(*size, video.aspect, show_code, args.cell)
                term.write("\x1b[0m\x1b[2J")
                now_t = args.start if clock0 is None else args.start + time.perf_counter() - clock0 - args.sync
                if frames:
                    frames.close()
                frames = Frames(ff, args.video, (lay.video[2] * SX, lay.video[3] * SY), fps, max(args.start, now_t))

            if clock0 is None:                        # wait for ffmpeg, then start the clock
                note = "warming up the projector ..."
                term.write(f"\x1b[{size[1] // 2};{max(1, (size[0] - len(note)) // 2)}H\x1b[38;2;110;110;122m{note}")
                frames.get(frames.first)
                if sound:
                    sound.play()
                clock0 = time.perf_counter()

            clock = time.perf_counter() - clock0
            index = max(frames.first, int((args.start + clock - args.sync) * fps))
            frame = frames.get(index) if index < total else None
            if frame is None:                         # the end: stop, or go round again
                if not args.loop:
                    break
                frames.close()
                frames = Frames(ff, args.video, (lay.video[2] * SX, lay.video[3] * SY), fps, args.start)
                frames.get(frames.first)
                if sound:
                    sound.stop()
                    sound.play()
                clock0 = time.perf_counter()
                continue

            now = time.perf_counter()
            if last is not None:
                info["fps"] += (1 / max(now - last, 1e-3) - info["fps"]) * 0.1
            last = now
            info["frame"] = index
            compose(scr, lay, frame, look, ink, stars, code, clock, index / fps, info)
            term.write(scr.flush())
            shown += 1
            wait = clock0 + (index + 1) / fps - args.start + args.sync - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
    finally:
        if frames:
            frames.close()
    return shown, (time.perf_counter() - clock0) if clock0 else 0.0, colours


def main():
    ap = argparse.ArgumentParser(description="play a video as living ASCII art in the terminal")
    ap.add_argument("video", nargs="?", default=EDIT)
    ap.add_argument("--no-sign", action="store_true", help="don't draw your @ (signature.npz) over the closing card")
    ap.add_argument("--look", choices=("ascii", "pixels"), default="ascii",
                    help="ascii = glyphs on black like the rose, pixels = sharp colour blocks")
    ap.add_argument("--no-code", action="store_true", help="hide the code pane")
    ap.add_argument("--mute", action="store_true", help="no sound")
    ap.add_argument("--loop", action="store_true", help="play forever")
    ap.add_argument("--start", type=float, default=0.0, help="start this many seconds in")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--tag", help='the credit line in the corner, e.g. "@yourname"')
    ap.add_argument("--cps", type=float, default=170.0, help="typing speed of the code pane")
    ap.add_argument("--cell", type=float, default=2.0, help="height / width of one terminal cell")
    ap.add_argument("--sync", type=float, default=0.0, help="delay the picture (s) if sound runs late")
    ap.add_argument("--colours", "--colors", choices=("auto", "24", "256"), default="auto",
                    help="24-bit colour or the 256 palette (auto picks 256 in the old Windows console)")
    args = ap.parse_args()

    ff = find_ffmpeg()
    video = Video(ff, args.video)
    print(f"loading {os.path.basename(args.video)} ...", flush=True)
    sound = Sound(ff, args.video, args.start) if video.audio and not args.mute else None
    term = Terminal()
    shown, secs, colours = 0, 0.0, 24
    try:
        term.open()
        shown, secs, colours = play(args, ff, video, sound, term)
    except KeyboardInterrupt:
        pass
    finally:
        term.close()
        if sound:
            sound.close()
    if secs:
        print(f"drew {shown} frames in {secs:.1f}s  ({shown / secs:.1f} fps, {colours}-bit colour)"
              if colours == 24 else f"drew {shown} frames in {secs:.1f}s  ({shown / secs:.1f} fps, 256 colours)")
        if os.name == "nt" and colours == 256:
            print("tip: Windows Terminal or the VS Code terminal show full colour at a smoother frame rate")


if __name__ == "__main__":
    main()
