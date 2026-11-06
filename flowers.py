#!/usr/bin/env python3
"""
flowers.py - a little garden grows in your terminal under the stars, then spins,
to "Reflections" by Malcolm Todd (0:38-1:15, looping: reflections.m4a).

    python flowers.py
    python flowers.py --speed 0.6       spin faster from the start
    python flowers.py --mute            no music

keys:   up / down   (or + / -)      spin faster / slower
        right / left                push the spin that way (through zero and back)
        space  pause     r  reverse     g  grow it all again
        m  switch look (hd pixels / letters)
        c  show / hide the code         q  quit

needs numpy, plus art.py next to it (the screen + terminal plumbing lives there)
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

from art import (CHARS, C_HUD, C_PINK, C_RULE, C_STATUS, SHAPE, Code, Layout, Screen, Sound, Stars, Terminal,
                 find_ffmpeg, pack)

HERE = os.path.dirname(os.path.abspath(__file__))
SONG = os.path.join(HERE, "reflections.m4a")   # 0:38-1:15 of the song; its end melts into its start, so it loops
CREDIT = "reflections · malcolm todd"
LEAD = 0.39             # the music starts this much before the garden, so the spin begins on the big beat
TAU = 2 * math.pi
TILT = 0.26             # the camera looks down on the garden a little (radians)
AIM_Y = 0.78            # the height the camera aims at
DIST = 4.2              # camera distance, for a touch of perspective
SPAN_X, SPAN_Y = 2.0, 1.75   # how much of the world has to fit on screen (wide, tall)
GROW, OPEN = 4.0, 3.2   # seconds for a stem to grow, and for its flower to open
MAX_SPIN = 3.0          # turns per second, either way


# ── the garden ──────────────────────────────────────────────────────────────
# every flower: its stem runs from base to top (x, height, z), it starts growing
# at `start` seconds, its head is `size` times life size and leans out by `tilt`
# degrees, and its leaves sit at (height up the stem, turn in degrees, length)
GARDEN = [
    dict(kind="lavender", base=(0.04, 0, -0.05), top=(0.42, 1.05, -0.40), start=0.5, size=1.4, tilt=10,
         leaves=[(0.22, 40, 0.20), (0.36, 220, 0.18)]),
    dict(kind="tulip", base=(-0.06, 0, 0.03), top=(-0.55, 1.02, 0.12), start=0.9, size=1.5, tilt=15,
         leaves=[(0.04, 150, 0.56), (0.09, 330, 0.50)]),
    dict(kind="daisy", base=(0.06, 0, 0.04), top=(0.50, 0.88, 0.32), start=1.3, size=1.6, tilt=50,
         leaves=[(0.30, 250, 0.26), (0.48, 80, 0.24)]),
    dict(kind="lily", base=(-0.03, 0, -0.06), top=(-0.25, 1.15, -0.50), start=1.7, size=1.45, tilt=40,
         leaves=[(0.18, 120, 0.38), (0.40, 300, 0.34)]),
    dict(kind="rose", base=(0.0, 0, 0.0), top=(0.0, 1.30, -0.04), start=2.1, size=1.7, tilt=25,
         leaves=[(0.30, 200, 0.34), (0.50, 20, 0.30)]),
]


# ── the art ─────────────────────────────────────────────────────────────────
# flowers are real 3d surfaces: petals and leaves are bent sheets, stems are
# curves. each frame they are spun, lit, squashed onto the character grid,
# and the nearest point in every cell decides its glyph: bright faces get
# dense letters, outlines get / \ ( ) _ - that follow the edge.
def smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def ease_out(x):
    return 1 - (1 - np.clip(x, 0.0, 1.0)) ** 3


def lerp(a, b, t):
    return a + (b - a) * t


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def frame_for(axis):
    """three unit rows (x, y, z) of a frame whose y points along `axis`."""
    a = unit(np.asarray(axis, float))
    ref = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 0, 1.0])
    x = unit(ref - a * (ref @ a))
    return np.stack([x, a, np.cross(x, a)])


def rgb01(c):
    return np.asarray(c, float) / 255


class Bits:
    """a pile of points with everything the renderer needs to know about each one.
    `part` numbers the separate pieces (each petal, each leaf) so outlines know where one ends."""

    def __init__(self, P, N, C, T=None, part=None, thin=False, shine=0.0):
        P = np.asarray(P, float)
        n = P.size // 3
        self.P = P.reshape(n, 3)
        self.N = np.broadcast_to(N, P.shape).reshape(n, 3)
        self.C = np.broadcast_to(C, P.shape).reshape(n, 3)
        self.T = np.zeros((n, 3)) if T is None else np.broadcast_to(T, P.shape).reshape(n, 3)
        self.part = np.zeros(n, np.int64) if part is None else np.broadcast_to(part, P.shape[:-1]).reshape(n)
        self.thin = np.full(n, thin)
        self.shine = np.full(n, float(shine))


class Stem:
    """a gentle curve from the ground to the flower (a quadratic bezier)."""

    def __init__(self, base, top, radius):
        self.B, self.E, self.r = np.array(base, float), np.array(top, float), radius
        self.K = self.B + (self.E - self.B) * np.array([0.15, 0.62, 0.15])   # rise first, then lean
        self.length = np.linalg.norm(self.E - self.B) * 1.08

    def at(self, s):
        s = np.asarray(s, float)[:, None]
        p = (1 - s) ** 2 * self.B + 2 * (1 - s) * s * self.K + s * s * self.E
        d = 2 * (1 - s) * (self.K - self.B) + 2 * s * (self.E - self.K)
        return p, unit(d)

    def bits(self, g, res, colour):
        n = int(np.clip(self.length * g * res * 1.2, 3, 400))
        s = np.linspace(0, g, n)
        c, t = self.at(s)
        n1 = unit(np.cross(t, [0, 0, 1.0]))
        n2 = np.cross(t, n1)
        a = np.linspace(0, TAU, 6, endpoint=False)[None, :, None]
        ring = np.cos(a) * n1[:, None] + np.sin(a) * n2[:, None]
        P = c[:, None] + self.r * (1 - 0.35 * s)[:, None, None] * ring
        shade = lerp(rgb01((36, 110, 42)), rgb01((84, 165, 64)), s[:, None, None] / max(g, 1e-6))
        return Bits(P, ring, np.broadcast_to(shade * colour, P.shape), T=np.broadcast_to(t[:, None], P.shape), thin=True)


def leaf(origin, turn, rise, length, width, droop, f, res):
    """a leaf unfolding from the stem: f = 0 is tucked against it, 1 is wide open."""
    elev = lerp(math.radians(84), math.radians(rise), f)
    h = np.array([math.cos(turn), 0, math.sin(turn)])
    d = unit(h * math.cos(elev) + np.array([0, 1.0, 0]) * math.sin(elev))
    w = unit(np.cross([0, 1.0, 0], d))
    n = np.cross(d, w)
    L, W = length * (0.12 + 0.88 * f), width * f ** 0.7 + 1e-4
    nu, nv = int(np.clip(L * res * 1.1, 4, 80)), int(np.clip(2 * W * res * 1.1, 3, 30))
    u = np.linspace(0, 1, nu)[:, None]
    v = np.linspace(-1, 1, nv)[None, :]
    lat = v * W * np.sin(np.pi * u ** 0.8) ** 0.9 * (1 - 0.2 * u)
    lift = 0.9 * lat * lat / W - droop * (u * L) ** 2
    P = origin + d * (u * L)[..., None] + w * lat[..., None] + n * lift[..., None]
    du, dv = np.gradient(P, axis=0), np.gradient(P, axis=1)
    rib = np.clip(1 - np.abs(v) * 5, 0, 1)[..., None] * 0.12
    side = (np.clip(np.cos((u - 0.45 * np.abs(v)) * TAU * 6), 0, 1) ** 8 * (np.abs(v) < 0.88) * 0.1)[..., None]
    C = lerp(rgb01((30, 98, 38)), rgb01((96, 178, 72)), u[..., None]) + rib + side   # midrib and side veins
    return Bits(P, unit(np.cross(du, dv)), C, shine=0.12)


class Petals:
    """a ring or spiral of petals, one number per petal for each property."""

    def __init__(self, phi, length, width, r0, h0, closed, opened, bend0, bend1, cup, shape,
                 base, tip, shine, fade=0.6, stripe=None, spots=None, veins=(0, 0.0)):
        k = np.shape(phi)
        f = lambda x: np.broadcast_to(np.asarray(x, float), k).copy()   # noqa: E731
        self.phi, self.L, self.W, self.r0, self.h0 = f(phi), f(length), f(width), f(r0), f(h0)
        self.closed, self.opened = np.radians(f(closed)), np.radians(f(opened))
        self.bend0, self.bend1, self.cup = f(bend0), f(bend1), f(cup)
        self.shape, self.base, self.tip, self.shine, self.fade = shape, rgb01(base), rgb01(tip), shine, fade
        self.stripe, self.spots, self.veins = stripe, spots, veins

    def bits(self, b, res):
        """b = how open the flower is, 0 bud .. 1 full bloom. points are in head space (axis = +y)."""
        L = self.L * lerp(0.55, 1.0, b)
        nu = int(np.clip(L.max() * res * 1.05, 5, 60))
        nv = int(np.clip(2 * self.W.max() * res * 1.05, 4, 44))
        u = np.linspace(0, 1, nu)[None, :, None]
        v = np.linspace(-1, 1, nv)[None, None, :]
        col = lambda x: x[:, None, None]                                  # noqa: E731
        # the spine of each petal: it leaves the centre at an angle and keeps bending
        ang = col(lerp(self.closed, self.opened, b)) + col(lerp(self.bend0, self.bend1, b)) * u * col(L)
        s, c = np.sin(ang), np.cos(ang)
        rho = col(self.r0) + col(L) * (np.cumsum(s, 1) - s[:, :1]) / (nu - 1)
        hgt = col(self.h0) + col(L) * (np.cumsum(c, 1) - c[:, :1]) / (nu - 1)
        if self.shape == "round":
            prof = u ** 0.45 * np.sqrt(np.clip(1 - u ** 5, 0, 1))
        elif self.shape == "strap":
            prof = np.sqrt(np.clip(u * 6, 0, 1) * np.clip(1 - u ** 8, 0, 1))
        else:
            prof = np.sin(np.pi * u ** 0.7) ** 1.1
        lat = v * col(self.W) * prof                                      # across the petal
        out = col(self.cup) * lat * lat / col(self.W)                      # the cup of the petal
        cp, sp = np.cos(self.phi)[:, None, None], np.sin(self.phi)[:, None, None]
        r = rho - out * c
        P = np.stack(np.broadcast_arrays(r * cp - lat * sp, hgt + out * s, r * sp + lat * cp), -1)
        du, dv = np.gradient(P, axis=1), np.gradient(P, axis=2)
        C = lerp(self.base, self.tip, (u ** self.fade)[..., None]) * (1 - 0.4 * np.abs(v) ** 6)[..., None]
        count, depth = self.veins                                       # fine veins running up the petal
        C = C * (1 - depth * (0.5 + 0.5 * np.cos(v * count * np.pi)) ** 6 * (0.3 + 0.7 * u))[..., None]
        C = np.broadcast_to(C, P.shape).copy()                          # darker rims keep petals apart
        if self.stripe is not None:                                       # a lily's painted stripe
            w = (np.exp(-(v / 0.22) ** 2) * (1 - u) ** 0.5 * 0.8)[..., None]
            C = lerp(C, rgb01(self.stripe), np.broadcast_to(w, C.shape))
        if self.spots is not None:                                        # and its freckles
            k = np.arange(len(self.phi))[:, None, None]
            spot = (np.sin(u * 91 + v * 37 + k * 13) * np.sin(u * 53 - v * 71) > 0.82) & (u < 0.55) & (np.abs(v) < 0.65)
            C[spot] = rgb01(self.spots)
        petal = np.arange(len(self.phi))[:, None, None]                   # every petal is its own part
        return Bits(P, unit(np.cross(du, dv)), C, part=np.broadcast_to(petal, P.shape[:3]), shine=self.shine)


def head(kind):
    """the petal sets that make each kind of flower."""
    if kind == "rose":                                # a golden-angle spiral, tight inside, loose outside
        sets = []
        for k in (np.arange(0, 10), np.arange(10, 24)):
            q = k / 23
            sets.append(Petals(np.radians(k * 137.508), 0.09 + 0.17 * q, 0.05 + 0.09 * q, 0.004 + 0.022 * q,
                               -0.035 * q, 4 + 14 * q, 8 + 60 * q ** 1.4, -3.0 + q,
                               -3.2 * (1 - q) ** 2 + 3.6 * q * q, 0.75 - 0.4 * q, "round",
                               (110, 6, 32), (238, 48, 98), 0.25, veins=(5, 0.07)))
        return sets + [Petals(np.radians(np.arange(5) * 72 + 18), 0.075, 0.026, 0.01, -0.03, 15, 125, 0, 1.5,
                              0.3, "point", (40, 110, 40), (82, 160, 62), 0.05)]       # the green sepals
    if kind == "tulip":
        phi = np.radians([0, 120, 240, 60, 180, 300])
        inner = np.array([1, 1, 1, 0, 0, 0])
        return [Petals(phi, 0.31 - 0.02 * inner, 0.155 - 0.015 * inner, 0.018 - 0.012 * inner, 0,
                       5, 30 - 10 * inner, -1.4, -0.5, 1.15, "round", (255, 226, 70), (255, 128, 18), 0.4, fade=0.5,
                       veins=(11, 0.09))]
    if kind == "daisy":
        k = np.arange(21)
        return [Petals(np.radians(k * 360 / 21 + 4 * np.sin(k * 2.3)), 0.23 + 0.02 * np.sin(k * 1.7), 0.032,
                       0.05, 0.012, 12, 82 + 5 * np.sin(k * 3.1), -1.2, 0.5, 0.15, "strap",
                       (255, 236, 170), (255, 250, 255), 0.12, veins=(2, 0.16))]
    if kind == "lily":
        return [Petals(np.radians(np.arange(6) * 60 + 30), 0.33, 0.072, 0.012, 0, 6, 46, -0.8, 4.4, 0.45,
                       "point", (255, 250, 246), (255, 140, 196), 0.3, stripe=(214, 32, 122), spots=(140, 16, 72),
                       veins=(5, 0.1))]
    return []


def disk(b, res):
    """the golden middle of a daisy: a low dome."""
    n = int(np.clip(0.06 * res * 3, 6, 40))
    a = np.linspace(0, 1, n)[:, None]
    th = np.linspace(0, TAU, 2 * n, endpoint=False)[None, :]
    R, H = 0.052, 0.03 * (0.4 + 0.6 * b)
    slope = 2 * H * a / R
    P = np.stack(np.broadcast_arrays(R * a * np.cos(th), 0.012 + H * (1 - a * a), R * a * np.sin(th)), -1)
    N = unit(np.stack(np.broadcast_arrays(slope * np.cos(th), np.ones_like(a), slope * np.sin(th)), -1))
    grain = (0.85 + 0.15 * np.sin(a * 40) * np.sin(th * 9))[..., None]
    C = lerp(rgb01((214, 104, 20)), rgb01((255, 206, 42)), a[..., None]) * grain
    return Bits(P, N, np.broadcast_to(C, P.shape), shine=0.2)


def stamens(b, res):
    """six lily stamens: thin threads with a dusty anther on each."""
    phi = np.radians(np.arange(6) * 60)[:, None]
    n = int(np.clip(0.22 * res * 1.5, 6, 40))
    s = np.linspace(0, 1, n)[None, :]
    ang = math.radians(lerp(4, 28, b)) + 0.6 * s
    rho = 0.21 * np.cumsum(np.sin(ang), 1) / n
    y = 0.01 + 0.21 * np.cumsum(np.cos(ang), 1) / n * lerp(0.5, 1, b)
    P = np.stack(np.broadcast_arrays(rho * np.cos(phi), y, rho * np.sin(phi)), -1)
    T = unit(np.gradient(P, axis=1))
    thread = Bits(P, T, rgb01((232, 236, 200)), T=T, thin=True)
    tip = P[:, -1]
    o = np.array([[0.01, 0, 0], [-0.01, 0, 0], [0, 0.008, 0], [0, 0, 0.01], [0, 0, -0.01], [0, -0.006, 0]])
    A = tip[:, None] + o[None]
    dust = Bits(A, unit(o)[None].repeat(6, 0), rgb01((200, 86, 26)), part=np.arange(6)[:, None], shine=0.1)
    return [thread, dust]


def florets(stem, g, size):
    """lavender: little violet buds spiralling up the top of the stem."""
    s = np.linspace(0.62, 1.0, 22)
    pop = smooth((g - s) / 0.08)
    s, pop = s[pop > 0], pop[pop > 0]
    if not len(s):
        return []
    c, t = stem.at(s)
    k = np.arange(len(s)) * 2.4
    side = unit(np.cross(t, [0, 0, 1.0]))
    side = side * np.cos(k)[:, None] + np.cross(t, side) * np.sin(k)[:, None]
    centre = c + side * 0.028 * size
    r = (0.026 - 0.012 * (s - 0.62) / 0.38) * pop * size
    la = np.linspace(0, np.pi, 6)[None, :, None]
    lo = np.linspace(0, TAU, 10, endpoint=False)[None, None, :]
    ball = np.stack(np.broadcast_arrays(np.sin(la) * np.cos(lo), np.cos(la), np.sin(la) * np.sin(lo)), -1)
    P = centre[:, None, None] + r[:, None, None, None] * ball
    C = lerp(rgb01((196, 146, 255)), rgb01((118, 72, 222)), ((s - 0.62) / 0.38)[:, None, None, None])
    bud = np.arange(len(s))[:, None, None]
    return [Bits(P, np.broadcast_to(ball, P.shape), np.broadcast_to(C, P.shape), part=bud, shine=0.15)]


def grass(f, res):
    """a tuft of grass blades around the base, drawn as thin strokes."""
    rng = np.random.default_rng(11)
    n = 34
    a, r = rng.uniform(0, TAU, n), rng.uniform(0.02, 0.26, n)
    h, lean = rng.uniform(0.10, 0.30, n) * f, rng.uniform(0.25, 0.75, n)
    m = int(np.clip(0.3 * res * 1.5, 4, 24))
    s = np.linspace(0, 1, m)[None, :]
    out = np.stack([np.cos(a), np.zeros(n), np.sin(a)], 1)[:, None]
    P = (r[:, None, None] * out + (lean * h)[:, None, None] * out * (s * s)[..., None]
         + np.array([0, 1.0, 0]) * (h[:, None] * s)[..., None])
    T = unit(np.gradient(P, axis=1))
    C = lerp(rgb01((26, 86, 34)), rgb01((92, 172, 66)), s[..., None])
    return Bits(P, T, np.broadcast_to(C, P.shape), T=T, thin=True)


class Garden:
    """grows the flowers over time, and hands back all their points for a moment."""

    def __init__(self):
        self.flowers = []
        for i, spec in enumerate(GARDEN):
            radius = 0.012 if spec["kind"] == "lavender" else 0.019 if spec["kind"] == "rose" else 0.016
            self.flowers.append(dict(spec, stem=Stem(spec["base"], spec["top"], radius), sets=head(spec["kind"]),
                                     phase=i * 1.7))
        self.done = max(f["start"] for f in GARDEN) + GROW * 0.85 + OPEN
        self.cache, self.kept = None, {}              # finished flowers don't need rebuilding

    def stage(self, f, t):
        """(stem grown 0-1, flower open 0-1) for one flower at time t."""
        return float(ease_out((t - f["start"]) / GROW)), float(smooth((t - f["start"] - GROW * 0.85) / OPEN))

    def bloom(self, t):
        return float(np.mean([self.stage(f, t)[1] for f in self.flowers]))

    def points(self, t, res):
        """every point in the garden at time t, plus the tips still growing (for sparkles)."""
        if t >= self.done and self.cache and self.cache[0] == res:
            return self.cache[1], []
        tuft = float(smooth(t / 1.4))
        if tuft < 1 or ("grass", res) not in self.kept:
            self.kept[("grass", res)] = [grass(tuft, res)]
        bits, tips, phase = list(self.kept[("grass", res)]), [], [0.0]
        for f in self.flowers:
            g, b = self.stage(f, max(t, 0))
            if g <= 0.01:
                continue
            start, key = len(bits), (f["kind"], res)
            if g >= 1 and b >= 1 and key in self.kept:
                bits += self.kept[key]
                phase += [f["phase"]] * (len(bits) - start)
                continue
            stem = f["stem"]
            bits.append(stem.bits(g, res, 1.0))
            wide = 0.12 if f["kind"] == "tulip" else 0.095
            rise = 68 if f["kind"] == "tulip" else 32
            for n, (at, turn, length) in enumerate(f["leaves"]):
                open_, lk = float(smooth((g - at) / 0.25)), (f["kind"], n, res)
                if open_ >= 1 and lk in self.kept:            # an open leaf never changes again
                    bits.append(self.kept[lk])
                elif open_ > 0:
                    origin = stem.at([at])[0][0]
                    bits.append(leaf(origin, math.radians(turn), rise, length, wide, 1.1, open_, res))
                    if open_ >= 1:
                        self.kept[lk] = bits[-1]
            tip, tangent = stem.at([g])
            tip, tangent = tip[0], tangent[0]
            if g < 0.995:
                tips.append(tip)
            if f["kind"] == "lavender":
                bits += florets(stem, g, f["size"])
            else:
                size = f["size"] * (0.3 + 0.7 * float(smooth((g - 0.2) / 0.8)))
                out = np.array([f["top"][0], 0, f["top"][2]])
                out = out / np.linalg.norm(out) if np.linalg.norm(out) > 0.1 else np.array([0, 0, 1.0])
                lean = math.radians(f["tilt"])
                rot = frame_for(unit(out * math.sin(lean) + np.array([0, math.cos(lean), 0]) + tangent * 0.3))
                parts = [p.bits(b, res * size) for p in f["sets"]]
                if f["kind"] == "daisy" and b > 0:
                    parts.append(disk(b, res * size))
                if f["kind"] == "lily" and b > 0.15:
                    parts += stamens(b, res * size)
                for p in parts:                                   # head space -> the garden
                    p.P = tip + size * (p.P @ rot)
                    p.N, p.T = p.N @ rot, p.T @ rot
                    bits.append(p)
            if g >= 1 and b >= 1:
                self.kept[key] = bits[start:]
            phase += [f["phase"]] * (len(bits) - start)
        part, base = [], 0
        for p in bits:                                            # one number per petal / leaf / stem
            part.append(p.part + base)
            base += int(p.part.max()) + 1 if len(p.part) else 1
        out = (np.concatenate([b.P for b in bits]), np.concatenate([b.N for b in bits]),
               np.concatenate([b.T for b in bits]), np.concatenate([b.C for b in bits]),
               np.concatenate(part), np.concatenate([b.thin for b in bits]),
               np.concatenate([b.shine for b in bits]),
               np.concatenate([np.full(len(b.P), ph) for b, ph in zip(bits, phase)]))
        if t >= self.done:
            self.cache = (res, out)
        return out, tips


# ── light, camera, glyphs ───────────────────────────────────────────────────
KEY = unit(np.array([-0.55, 0.65, 0.55]))        # main light: up, left, in front
FILL = unit(np.array([0.7, 0.1, 0.4]))
HALF = unit(KEY + np.array([0, 0, 1.0]))
RAMP = np.array(list(" .,:;=+*?%#&8$@"))         # light to dense
LINE = np.array(list("-/|\\"))                   # by the slope of a thin stroke
SUBX, SUBY = 2, 4                                # every cell is sampled 2 across x 4 down (square samples)
QUADS = np.array([[0, 2], [1, 3], [4, 6], [5, 7]])   # the samples in each quarter: TL, TR, BL, BR
GLYPH8 = SHAPE.reshape(len(SHAPE), 4, 2, 2, 2).mean((2, 4)).reshape(len(SHAPE), 8)   # glyphs at 2x4
GLYPH8_E = (GLYPH8 ** 2).sum(1)


class View:
    """the camera, pointed at the garden and fitted to the art pane."""

    def __init__(self, ax, ay, aw, ah, cell, dither=False, room=(1, 5)):
        self.ax, self.ay, self.aw, self.ah, self.cell = ax, ay, aw, ah, cell
        # with only 256 colours, a fine 2x2 pattern of nudges hides the steps between shades
        bayer = (np.array([[0, 2], [3, 1]]) / 4 - 0.375) * (0.1 if dither else 0.0)
        cols = np.tile(np.arange(aw) % 2, ah)
        rows = np.repeat(np.arange(ah) % 2, aw)
        self.nudge = dict(top=bayer[0, cols], bottom=bayer[1, cols], left=bayer[rows, 0], right=bayer[rows, 1])
        top, bottom = room[0], ah - room[1]           # room for the clock and the notes
        tall = max(4, bottom - top)
        self.k = min(aw * 0.94 / SPAN_X, tall * cell / SPAN_Y)   # cells per unit, sideways
        self.cx, self.cy = aw / 2, top + tall / 2
        self.res = min(1.6 * self.k, 90)              # points per unit: just enough to fill the cells
        self.grain = np.random.default_rng(3).uniform(-0.45, 0.45, ah * aw)

    def project(self, P, spin):
        M = rot_x(TILT) @ rot_y(spin)
        Q = (P - np.array([0, AIM_Y, 0])) @ M.T
        f = DIST / (DIST - Q[:, 2])
        return self.cx + Q[:, 0] * f * self.k, self.cy - Q[:, 1] * f * self.k / self.cell, DIST - Q[:, 2], M

    def draw(self, scr, pts, t, spin, look):
        """paint the garden into the screen; returns the depth of every cell (inf = sky)."""
        P, N, T, C, part, thin, shine, phase = pts
        sway = 0.02 * P[:, 1] ** 2                    # a breeze, stronger up high
        P = P + np.stack([sway * np.sin(1.25 * t + phase), np.zeros_like(sway),
                          0.7 * sway * np.cos(1.05 * t + phase)], 1)
        col, row, z, M = self.project(P, spin)
        Nn, Tn = N @ M.T, T @ M.T

        # light: two lamps, a shine, and a rim of light on the edges
        face = np.abs(Nn[:, 2])
        n2 = Nn * np.where(Nn[:, 2] < 0, -1.0, 1.0)[:, None]
        spec = shine * np.clip(n2 @ HALF, 0, None) ** 24
        lit = 0.26 + 0.66 * np.clip(n2 @ KEY, 0, None) + 0.26 * np.clip(n2 @ FILL, 0, None) + 0.38 * (1 - face) ** 2 + spec
        rgb = np.clip(C * (0.35 + 0.8 * lit)[:, None] + 0.55 * spec[:, None], 0, 1)

        # every cell is split into 2x4 square samples, and the nearest point in each sample wins.
        # stems and grass are laid down two samples wide so they don't vanish
        W, H = self.aw * SUBX, self.ah * SUBY
        xi, yi = np.floor(col * SUBX).astype(np.int64), np.floor(row * SUBY).astype(np.int64)
        src = np.concatenate([np.arange(len(z)), np.flatnonzero(thin)])
        xi, yi = np.concatenate([xi, xi[thin] + 1]), np.concatenate([yi, yi[thin]])
        ok = (xi >= 0) & (xi < W) & (yi >= 0) & (yi < H)
        pix, who = yi[ok] * W + xi[ok], src[ok]
        depth = np.full(W * H, np.inf)
        np.minimum.at(depth, pix, z[who])
        win = z[who] <= depth[pix]
        owner = np.full(W * H, -1)
        owner[pix[win]] = who[win]

        # close pinholes: an empty sample between two full ones copies the nearer neighbour
        o2, d2 = owner.reshape(H, W), depth.reshape(H, W)
        for axis in (1, 0):
            a, b = np.roll(o2, 1, axis), np.roll(o2, -1, axis)
            da, db = np.roll(d2, 1, axis), np.roll(d2, -1, axis)
            hole = (o2 < 0) & (a >= 0) & (b >= 0)
            first = da <= db
            o2, d2 = np.where(hole, np.where(first, a, b), o2), np.where(hole, np.where(first, da, db), d2)

        # regroup sample by cell: (cells, 8)
        def cellwise(x):
            return x.reshape(self.ah, SUBY, self.aw, SUBX).transpose(0, 2, 1, 3).reshape(self.ah * self.aw, 8)

        O8, D8 = cellwise(o2), cellwise(d2)
        full = O8 >= 0
        solid = full.any(1)
        safe = np.where(full, O8, 0)
        rgb8 = np.where(full[..., None], rgb[safe], 0.0)
        y0, x0, cw, chh = self.ay, self.ax, self.aw, self.ah
        out_ch, out_fg = scr.ch[y0: y0 + chh, x0: x0 + cw].ravel().copy(), scr.fg[y0: y0 + chh, x0: x0 + cw].ravel().copy()
        out_bg = scr.bg[y0: y0 + chh, x0: x0 + cw].ravel().copy()

        if look == "hd":
            # two coloured pixels per cell: split top/bottom (▀) or left/right (▌), whichever fits
            q = rgb8[:, QUADS].mean(2)                                    # TL, TR, BL, BR
            top, bottom = (q[:, 0] + q[:, 1]) / 2, (q[:, 2] + q[:, 3]) / 2
            left, right = (q[:, 0] + q[:, 2]) / 2, (q[:, 1] + q[:, 3]) / 2
            miss_rows = ((q[:, :2] - top[:, None]) ** 2).sum((1, 2)) + ((q[:, 2:] - bottom[:, None]) ** 2).sum((1, 2))
            miss_cols = ((q[:, ::2] - left[:, None]) ** 2).sum((1, 2)) + ((q[:, 1::2] - right[:, None]) ** 2).sum((1, 2))
            upright = miss_cols < miss_rows * 0.8
            nd, lit_ = self.nudge, lambda c: (c.max(1) > 0.03)[:, None]     # noqa: E731 - leave the sky black
            ink = np.where(upright[:, None], left + nd["left"][:, None] * lit_(left), top + nd["top"][:, None] * lit_(top))
            paper = np.where(upright[:, None], right + nd["right"][:, None] * lit_(right),
                             bottom + nd["bottom"][:, None] * lit_(bottom))
            out_ch[solid] = np.where(upright, "▌", "▀")[solid]
            out_fg[solid] = pack(ink.T)[solid]
            out_bg[solid] = pack(paper.T)[solid]
        else:
            # letters: each cell takes the glyph whose shape matches its front piece best
            front = np.where(full, D8, np.inf).argmin(1)
            fo = safe[np.arange(len(safe)), front]                       # the point in front, per cell
            mine = full & (part[safe] == part[fo][:, None])
            cov = mine.sum(1)
            colour = (rgb8 * mine[..., None]).sum(1) / np.maximum(cov, 1)[:, None]
            tone = np.clip(((lit[safe] * mine).sum(1) / np.maximum(cov, 1) - 0.15) / 0.8, 0, 1) ** 0.75
            glyph = RAMP[np.clip(np.rint(tone * (len(RAMP) - 1) + self.grain), 1, len(RAMP) - 1).astype(int)]
            partial = solid & (cov < 8)
            glyph[partial] = CHARS[(GLYPH8_E[None, :] - 2 * (0.78 * mine[partial]) @ GLYPH8.T).argmin(1)]
            # stems, grass and sheets seen edge-on: a stroke along their own direction
            stroke = solid & (thin[fo] | (face[fo] < 0.12))
            dx = np.where(thin[fo], Tn[fo, 0], -Nn[fo, 1])
            dy = np.where(thin[fo], Tn[fo, 1], Nn[fo, 0])
            slope = (np.degrees(np.arctan2(dy, dx)) + 202.5) % 180
            glyph[stroke] = LINE[(slope[stroke] // 45).astype(int) % 4]
            colour[stroke] *= 1.12
            out_ch[solid], out_fg[solid] = glyph[solid], pack(np.clip(colour, 0, 1).T)[solid]

        scr.ch[y0: y0 + chh, x0: x0 + cw] = out_ch.reshape(chh, cw)
        scr.fg[y0: y0 + chh, x0: x0 + cw] = out_fg.reshape(chh, cw)
        scr.bg[y0: y0 + chh, x0: x0 + cw] = out_bg.reshape(chh, cw)
        return np.where(full, D8, np.inf).min(1).reshape(chh, cw)


# ── the sky ─────────────────────────────────────────────────────────────────
def moon(scr, ax, ay, aw, ah, cell, hd=False):
    """a thin crescent up in the corner: letters, or two soft pixels per cell in hd."""
    R = float(np.clip(aw * 0.07, 3, 8))
    mx, my = ax + aw * 0.17, ay + ah * 0.12 + 1
    ys, xs = np.mgrid[int(my - R / cell) - 1: int(my + R / cell) + 2, int(mx - R) - 1: int(mx + R) + 2]
    keep = (ys >= ay) & (ys < ay + ah) & (xs >= ax) & (xs < ax + aw)
    ys, xs = ys[keep], xs[keep]
    free = (scr.ch[ys, xs] == " ") & (scr.bg[ys, xs] == 0)
    ys, xs = ys[free], xs[free]
    tint = np.array([0.96, 0.92, 0.74])[:, None]

    def light(fy):                                      # how much moon covers a point, and how bright
        dx, dy = (xs + 0.5 - mx) / R, (ys + fy - my) * cell / R
        inside = smooth((1 - np.sqrt(dx * dx + dy * dy)) * R * 1.5)
        shadow = smooth((np.sqrt((dx - 0.42) ** 2 + (dy + 0.12) ** 2) - 0.9) * R * 1.5)
        return inside * shadow, np.clip(0.55 - dx, 0, 1)

    if hd:
        (a_top, s_top), (a_bot, s_bot) = light(0.25), light(0.75)
        on = (a_top + a_bot) > 0.05
        scr.ch[ys[on], xs[on]] = "▀"
        scr.fg[ys[on], xs[on]] = pack(tint * (a_top * (0.55 + 0.45 * s_top))[on])
        scr.bg[ys[on], xs[on]] = pack(tint * (a_bot * (0.55 + 0.45 * s_bot))[on])
    else:
        a, shade = light(0.5)
        on = a > 0.5
        scr.ch[ys[on], xs[on]] = np.array(list(":*%&@"))[np.clip((shade[on] * 5).astype(int), 0, 4)]
        scr.fg[ys[on], xs[on]] = pack(tint * (0.55 + 0.45 * shade[on]))


class Sky:
    """shooting stars, fireflies, and the glitter thrown off by growing stems."""

    def __init__(self):
        self.rng = np.random.default_rng(7)
        self.comet, self.next_comet = None, 3.0
        n = 16
        self.fly = dict(r=self.rng.uniform(0.35, 0.95, n), y=self.rng.uniform(0.25, 1.6, n),
                        w=self.rng.uniform(0.15, 0.4, n) * self.rng.choice([-1, 1], n),
                        a=self.rng.uniform(0, TAU, n), blink=self.rng.uniform(0, TAU, n))
        self.dust = np.zeros((0, 7))                  # x y z vx vy vz age

    def sparkle(self, tips, dt):
        if tips:
            k = len(tips) * 3
            p = np.repeat(np.array(tips), 3, 0)
            v = self.rng.normal(0, 0.18, (k, 3)) + np.array([0, 0.25, 0])
            self.dust = np.concatenate([self.dust, np.c_[p, v, np.zeros(k)]])[-260:]
        if len(self.dust):
            self.dust[:, 3:6] *= 1 - 0.8 * dt
            self.dust[:, 4] -= 0.35 * dt
            self.dust[:, :3] += self.dust[:, 3:6] * dt
            self.dust[:, 6] += dt
            self.dust = self.dust[self.dust[:, 6] < 1.3]

    def draw(self, scr, view, depth, t, spin):
        ax, ay, aw, ah = view.ax, view.ay, view.aw, view.ah
        # a shooting star now and then
        if self.comet is None and t > self.next_comet:
            go = self.rng.choice([-1, 1])
            self.comet = (t, ax + aw * self.rng.uniform(0.2, 0.8), ay + ah * self.rng.uniform(0.05, 0.3),
                          go * self.rng.uniform(28, 40), self.rng.uniform(9, 14))
        if self.comet:
            t0, x0, y0, vx, vy = self.comet
            age = t - t0
            for k in range(14):
                a = age - k * 0.018
                x, y = int(x0 + vx * a), int(y0 + vy * a / view.cell * 0.7)
                if a < 0 or not (ax <= x < ax + aw and ay <= y < ay + ah) or scr.ch[y, x] != " ":
                    continue
                fade = max(0.0, 1 - k / 14) * max(0.0, 1 - age / 1.1)
                scr.ch[y, x] = "*" if k == 0 else ("\\" if vx > 0 else "/") if k < 5 else "."
                scr.fg[y, x] = pack(np.array([0.85, 0.9, 1.0]) * fade)
            if age > 1.1:
                self.comet, self.next_comet = None, t + self.rng.uniform(4, 8)

        # fireflies drifting round the garden, and fresh glitter
        f = self.fly
        ang = f["a"] + f["w"] * t
        flies = np.stack([f["r"] * np.cos(ang), f["y"] + 0.08 * np.sin(t * 0.9 + f["blink"]), f["r"] * np.sin(ang)], 1)
        glow = 0.5 + 0.5 * np.sin(t * 2.2 + f["blink"])
        self._dots(scr, view, depth, flies, 0.0, glow, np.array([1.0, 0.9, 0.45]))
        if len(self.dust):
            life = 1 - self.dust[:, 6] / 1.3
            self._dots(scr, view, depth, self.dust[:, :3], spin, life, np.array([1.0, 0.95, 0.85]))

    @staticmethod
    def _dots(scr, view, depth, P, spin, bright, tint):
        col, row, z, _ = view.project(P, spin)
        ci, ri = np.floor(col).astype(int), np.floor(row).astype(int)
        ok = (ci >= 0) & (ci < view.aw) & (ri >= 0) & (ri < view.ah) & (bright > 0.15)
        ci, ri, z, b = ci[ok], ri[ok], z[ok], bright[ok]
        front = z < depth[ri, ci]
        ci, ri, b = ci[front], ri[front], b[front]
        scr.ch[view.ay + ri, view.ax + ci] = np.where(b > 0.75, "*", np.where(b > 0.45, "+", "."))
        scr.fg[view.ay + ri, view.ax + ci] = pack(tint[:, None] * (0.35 + 0.65 * b))


# ── keys, notes, music, and the loop ────────────────────────────────────────
class Song(Sound):
    """the garden's music, on repeat (art.py's Sound, but looping)."""

    def __init__(self, ff, path):
        fd, self.wav = tempfile.mkstemp(prefix="garden_", suffix=".wav")
        os.close(fd)
        self.extract = subprocess.Popen(                 # no seeking: that would drop the first 23 ms
            [ff, "-nostdin", "-loglevel", "error", "-y", "-i", path, "-ac", "2", "-ar", "44100",
             "-c:a", "pcm_s16le", self.wav], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ok, self.proc = None, None

    def play(self):
        if not self.ready():
            return
        if os.name == "nt":
            import winsound
            winsound.PlaySound(self.wav, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP
                               | winsound.SND_NODEFAULT)
            return
        player = shutil.which("ffplay")
        if player:
            self.proc = subprocess.Popen([player, "-nodisp", "-loop", "0", "-loglevel", "quiet", self.wav],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            super().play()                            # (afplay / aplay: once through)


class Keys(Terminal):
    """the terminal from art.py, but arrow keys come back as names."""

    def key(self):
        if os.name == "nt":
            import msvcrt
            if not msvcrt.kbhit():
                return ""
            ch = msvcrt.getwch()
            if ch in ("\x00", "\xe0"):
                return {"K": "left", "M": "right", "H": "up", "P": "down"}.get(msvcrt.getwch(), "")
            return ch
        if self.saved is not None:
            import select
            if select.select([sys.stdin], [], [], 0)[0]:
                ch = os.read(sys.stdin.fileno(), 1).decode(errors="ignore")
                if ch == "\x1b" and select.select([sys.stdin], [], [], 0.02)[0]:
                    seq = os.read(sys.stdin.fileno(), 8).decode(errors="ignore")
                    return {"[A": "up", "[B": "down", "[C": "right", "[D": "left"}.get(seq[:2], "")
                return ch
        return ""


class Show:
    """one terminal-sized picture of everything: garden, sky, notes, code."""

    def __init__(self, size, show_code, cell, colours, cps):
        W, H = size
        self.scr = Screen(W, H, colours)
        self.lay = Layout(W, H, SPAN_X / SPAN_Y, show_code, cell)
        self.view = View(*self.lay.art, cell, dither=colours == 256)
        self.stars, self.code, self.cell = Stars(), Code(os.path.abspath(__file__), cps), cell

    def compose(self, garden, sky, t, spin, speed, paused, fps, tag, script, look="hd", song=False):
        scr, v = self.scr, self.view
        scr.clear()
        pts, tips = garden.points(t, v.res)
        depth = v.draw(scr, pts, t, spin, look)
        moon(scr, v.ax, v.ay, v.aw, v.ah, self.cell, hd=look == "hd")
        self.stars.draw(scr, v.ax, v.ay, v.aw, v.ah, t)
        sky.draw(scr, v, depth, t, spin)
        cells = int(np.isfinite(depth).sum())
        drawn = f"pixels {2 * cells:,}" if look == "hd" else f"letters {cells:,}"

        ax, ay, aw, ah = self.lay.art
        stamp = f" t {t:05.2f}s"
        scr.put(ax + aw - len(stamp) - 2, ay, "■", C_PINK)
        scr.put(ax + aw - len(stamp) - 1, ay, stamp, C_PINK)
        way = "||" if paused else ">>" if speed > 0.005 else "<<" if speed < -0.005 else "  "
        bar = int(round(abs(speed) / MAX_SPIN * 10))
        notes = (f"{tag} · {time.localtime().tm_year}" + (f"   ♪ {CREDIT}" if song else ""),
                 f"bloom {100 * garden.bloom(t):5.1f}%   spin {speed:+.2f} turns/s {way}",
                 f"{drawn}   [{'=' * bar}{'-' * (10 - bar)}]",
                 "up/dn speed  <-/-> push  space pause  r flip  g regrow  m look")
        for i, text in enumerate(notes):
            scr.put(ax + 1, ay + ah - 4 + i, text, C_HUD if i < 3 else C_RULE + 0x262630)
        sx, sy, sw = self.lay.status
        scr.put(sx, sy, f"$ py {script}", C_STATUS)
        right = f"running · {fps:.0f} fps"
        scr.put(sx + sw - len(right) - 1, sy, right, C_HUD)
        if self.lay.code:
            x, y, w, h = self.lay.code
            scr.put(x, y - 1, "─" * w, C_RULE)
            self.code.draw(scr, x, y, w, h, t)
        return tips


def main():
    ap = argparse.ArgumentParser(description="a garden grows in the terminal, then spins")
    ap.add_argument("--speed", type=float, default=0.25, help="spin, in turns per second (negative = other way)")
    ap.add_argument("--look", choices=("letters", "hd"), default="letters",
                    help="letters = glyph art like the rose, hd = two shaded pixels per character")
    ap.add_argument("--no-code", action="store_true", help="hide the code pane")
    ap.add_argument("--tag", default="a little garden", help='the credit line, e.g. "@yourname"')
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--cps", type=float, default=170.0, help="typing speed of the code pane")
    ap.add_argument("--cell", type=float, default=2.0, help="height / width of one terminal cell")
    ap.add_argument("--colours", "--colors", choices=("auto", "24", "256"), default="auto")
    ap.add_argument("--mute", action="store_true", help="no music")
    ap.add_argument("--song", default=SONG, help="the music (loops); reflections.m4a by default")
    args = ap.parse_args()

    song = None
    if not args.mute and os.path.isfile(args.song):
        try:
            song = Song(find_ffmpeg(), args.song)       # unpacked to a wav while the window opens
        except SystemExit:                            # no ffmpeg: the garden grows in silence
            song = None
    term, garden, sky = Keys(), Garden(), Sky()
    colours, show_code = Terminal.colours(args.colours), not args.no_code
    script = os.path.basename(sys.argv[0]) or "flowers.py"
    chosen, look = float(np.clip(args.speed, -MAX_SPIN, MAX_SPIN)), args.look
    show = size = None
    speed = spin = 0.0
    paused, fps, frames = False, args.fps, 0
    start = last = time.perf_counter()
    try:
        term.open()
        if song:
            song.play()
            start = last = time.perf_counter()        # the garden's clock starts with the music
        while not term.dead:
            key = term.key()
            k = key.lower()
            if k in ("q", "\x1b", "\x03"):
                break
            way = 1.0 if chosen >= 0 else -1.0
            if key == "up" or k in ("+", "=", "w"):                  # faster, whichever way it turns
                chosen = way * min(MAX_SPIN, round(abs(chosen) + 0.05, 2))
            if key == "down" or k in ("-", "_", "s"):                # slower, down to a standstill
                chosen = way * max(0.0, round(abs(chosen) - 0.05, 2))
            if key == "right" or k == "d":                           # push it round to the right
                chosen = min(MAX_SPIN, round(chosen + 0.05, 2))
            if key == "left" or k == "a":                            # or to the left
                chosen = max(-MAX_SPIN, round(chosen - 0.05, 2))
            if k == "r":
                chosen = -chosen
            if k == " ":
                paused = not paused
            if k == "g":                              # back to bare soil, and the song from the top
                if song:
                    song.stop()
                    song.play()
                start, spin, speed, sky = time.perf_counter(), 0.0, 0.0, Sky()
            if k == "c":
                show_code, size = not show_code, None
            if k == "m":
                look = "letters" if look == "hd" else "hd"
            if term.size() != size:
                size = term.size()
                show = Show(size, show_code, args.cell, colours, args.cps)
                term.write("\x1b[0m\x1b[2J")

            now = time.perf_counter()
            dt, last = min(now - last, 0.1), now
            t = max(0.0, now - start - (LEAD if song else 0.0))
            grown = t > garden.done + 0.4
            target = 0.0 if (paused or not grown) else chosen
            speed += (target - speed) * min(1.0, dt * 2.5)    # ease into any change of speed
            spin += speed * TAU * dt
            fps += (1 / max(dt, 1e-3) - fps) * 0.1

            tips = show.compose(garden, sky, t, spin, speed, paused, fps, args.tag, script, look, song is not None)
            sky.sparkle(tips, dt)
            term.write(show.scr.flush())
            frames += 1
            wait = 1 / args.fps - (time.perf_counter() - now)
            if wait > 0:
                time.sleep(wait)
    except KeyboardInterrupt:
        pass
    finally:
        term.close()
        if song:
            song.close()
    secs = time.perf_counter() - start
    if frames and secs > 0:
        print(f"drew {frames} frames in {secs:.1f}s  ({frames / secs:.1f} fps)")


if __name__ == "__main__":
    main()
