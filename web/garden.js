/* garden.js - the flowers. a web port of flowers.py from terminal-art.
   flowers are real 3d surfaces: petals and leaves are bent sheets, stems are curves.
   each frame they are spun, lit, squashed onto the character grid, and the nearest
   point in every cell decides its glyph: bright faces get dense letters, outlines
   get / \ ( ) _ - that follow the edge. */
"use strict";
(function () {
  const { TAU, clip, lerp, mod, pack, SPACE } = FY;
  const TILT = 0.26;              // the camera looks down on the garden a little (radians)
  const AIM_Y = 0.78;             // the height the camera aims at
  const DIST = 4.2;               // camera distance, for a touch of perspective
  const SPAN_X = 2.0, SPAN_Y = 1.75;
  const GROW = 4.0, OPEN = 3.2;   // seconds for a stem to grow, and for its flower to open
  FY.MAX_SPIN = 3.0;

  // every flower: its stem runs from base to top (x, height, z), it starts growing at
  // `start` seconds, its head is `size` times life size and leans out by `tilt` degrees,
  // and its leaves sit at (height up the stem, turn in degrees, length)
  const GARDEN = [
    { kind: "lavender", base: [0.04, 0, -0.05], top: [0.42, 1.05, -0.4], start: 0.5, size: 1.4, tilt: 10, leaves: [[0.22, 40, 0.2], [0.36, 220, 0.18]] },
    { kind: "tulip", base: [-0.06, 0, 0.03], top: [-0.55, 1.02, 0.12], start: 0.9, size: 1.5, tilt: 15, leaves: [[0.04, 150, 0.56], [0.09, 330, 0.5]] },
    { kind: "daisy", base: [0.06, 0, 0.04], top: [0.5, 0.88, 0.32], start: 1.3, size: 1.6, tilt: 50, leaves: [[0.3, 250, 0.26], [0.48, 80, 0.24]] },
    { kind: "lily", base: [-0.03, 0, -0.06], top: [-0.25, 1.15, -0.5], start: 1.7, size: 1.45, tilt: 40, leaves: [[0.18, 120, 0.38], [0.4, 300, 0.34]] },
    { kind: "rose", base: [0.0, 0, 0.0], top: [0.0, 1.3, -0.04], start: 2.1, size: 1.7, tilt: 25, leaves: [[0.3, 200, 0.34], [0.5, 20, 0.3]] },
  ];

  const rad = (d) => (d * Math.PI) / 180;
  const smooth = (x) => { x = clip(x, 0, 1); return x * x * (3 - 2 * x); };
  const easeOut = (x) => 1 - (1 - clip(x, 0, 1)) ** 3;
  const rgb01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
  const unit = (v) => {
    const l = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

  /** a pile of points with everything the renderer needs to know about each one.
      `part` numbers the separate pieces (each petal, each leaf) so outlines know where one ends. */
  function Bits(n, thin = false, shine = 0) {
    return {
      n, thin: thin ? 1 : 0, shine,
      P: new Float32Array(3 * n), N: new Float32Array(3 * n), T: new Float32Array(3 * n),
      C: new Float32Array(3 * n), part: new Int32Array(n),
    };
  }

  /** normals of a sheet of nu x nv points (from point `off`): the cross of its two slopes. */
  function sheetNormals(b, off, nu, nv) {
    const P = b.P, N = b.N;
    for (let a = 0; a < nu; a++) {
      const a0 = a > 0 ? a - 1 : 0, a1 = a < nu - 1 ? a + 1 : nu - 1;
      for (let c = 0; c < nv; c++) {
        const c0 = c > 0 ? c - 1 : 0, c1 = c < nv - 1 ? c + 1 : nv - 1;
        const i0 = (off + a0 * nv + c) * 3, i1 = (off + a1 * nv + c) * 3;
        const j0 = (off + a * nv + c0) * 3, j1 = (off + a * nv + c1) * 3;
        const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
        const vx = P[j1] - P[j0], vy = P[j1 + 1] - P[j0 + 1], vz = P[j1 + 2] - P[j0 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.max(Math.hypot(nx, ny, nz), 1e-9), k = (off + a * nv + c) * 3;
        N[k] = nx / l;
        N[k + 1] = ny / l;
        N[k + 2] = nz / l;
      }
    }
  }

  /** direction along `strands` lines of m points each: both T and N point along the line. */
  function lineTangents(b, strands, m) {
    const P = b.P;
    for (let i = 0; i < strands; i++) {
      for (let s = 0; s < m; s++) {
        const s0 = s > 0 ? s - 1 : 0, s1 = s < m - 1 ? s + 1 : m - 1;
        const p0 = (i * m + s0) * 3, p1 = (i * m + s1) * 3, k = (i * m + s) * 3;
        const t = unit([P[p1] - P[p0], P[p1 + 1] - P[p0 + 1], P[p1 + 2] - P[p0 + 2]]);
        for (let q = 0; q < 3; q++) b.T[k + q] = b.N[k + q] = t[q];
      }
    }
  }

  /** a gentle curve from the ground to the flower (a quadratic bezier). */
  class Stem {
    constructor(base, top, radius) {
      this.B = base;
      this.E = top;
      this.r = radius;
      this.K = [0, 1, 2].map((q) => base[q] + (top[q] - base[q]) * [0.15, 0.62, 0.15][q]);   // rise first, then lean
      this.length = Math.hypot(top[0] - base[0], top[1] - base[1], top[2] - base[2]) * 1.08;
    }
    at(s) {
      const { B, K, E } = this, a = (1 - s) ** 2, b = 2 * (1 - s) * s, c = s * s;
      const p = [0, 1, 2].map((q) => a * B[q] + b * K[q] + c * E[q]);
      const d = [0, 1, 2].map((q) => 2 * (1 - s) * (K[q] - B[q]) + 2 * s * (E[q] - K[q]));
      return [p, unit(d)];
    }
    bits(g, res) {
      const n = Math.floor(clip(this.length * g * res * 1.2, 3, 400));
      const out = Bits(n * 6, true, 0);
      const c0 = rgb01([36, 110, 42]), c1 = rgb01([84, 165, 64]);
      for (let i = 0; i < n; i++) {
        const s = (g * i) / (n - 1);
        const [p, t] = this.at(s);
        const n1 = unit([t[1], -t[0], 0]);                       // t x (0, 0, 1)
        const n2 = cross(t, n1);
        const r = this.r * (1 - 0.35 * s), k = s / Math.max(g, 1e-6);
        for (let a = 0; a < 6; a++) {
          const ca = Math.cos((a * TAU) / 6), sa = Math.sin((a * TAU) / 6), j = (i * 6 + a) * 3;
          for (let q = 0; q < 3; q++) {
            const ring = ca * n1[q] + sa * n2[q];
            out.P[j + q] = p[q] + r * ring;
            out.N[j + q] = ring;
            out.T[j + q] = t[q];
            out.C[j + q] = lerp(c0[q], c1[q], k);
          }
        }
      }
      return out;
    }
  }

  /** a leaf unfolding from the stem: f = 0 is tucked against it, 1 is wide open. */
  function leaf(origin, turn, rise, length, width, droop, f, res) {
    const elev = lerp(rad(84), rad(rise), f);
    const d = unit([Math.cos(turn) * Math.cos(elev), Math.sin(elev), Math.sin(turn) * Math.cos(elev)]);
    const w = unit(cross([0, 1, 0], d));
    const n = cross(d, w);
    const L = length * (0.12 + 0.88 * f), W = width * f ** 0.7 + 1e-4;
    const nu = Math.floor(clip(L * res * 1.1, 4, 80)), nv = Math.floor(clip(2 * W * res * 1.1, 3, 30));
    const out = Bits(nu * nv, false, 0.12);
    const lo = rgb01([30, 98, 38]), hi = rgb01([96, 178, 72]);
    for (let a = 0; a < nu; a++) {
      const u = a / (nu - 1);
      const env = Math.sin(Math.PI * u ** 0.8) ** 0.9 * (1 - 0.2 * u);
      for (let c = 0; c < nv; c++) {
        const v = -1 + (2 * c) / (nv - 1), av = Math.abs(v);
        const lat = v * W * env;
        const lift = (0.9 * lat * lat) / W - droop * (u * L) ** 2;
        const rib = clip(1 - av * 5, 0, 1) * 0.12;                 // the midrib
        const side = av < 0.88 ? clip(Math.cos((u - 0.45 * av) * TAU * 6), 0, 1) ** 8 * 0.1 : 0;   // side veins
        const k = (a * nv + c) * 3;
        for (let q = 0; q < 3; q++) {
          out.P[k + q] = origin[q] + d[q] * u * L + w[q] * lat + n[q] * lift;
          out.C[k + q] = lerp(lo[q], hi[q], u) + rib + side;
        }
      }
    }
    sheetNormals(out, 0, nu, nv);
    return out;
  }

  /** a ring or spiral of petals, one number per petal for each property. */
  class PetalSet {
    constructor(o) {
      const k = o.phi.length;
      const each = (x) => (Array.isArray(x) ? x.slice() : new Array(k).fill(x));
      this.k = k;
      this.phi = o.phi;
      this.L = each(o.length);
      this.W = each(o.width);
      this.r0 = each(o.r0);
      this.h0 = each(o.h0);
      this.closed = each(o.closed).map(rad);
      this.opened = each(o.opened).map(rad);
      this.bend0 = each(o.bend0);
      this.bend1 = each(o.bend1);
      this.cup = each(o.cup);
      this.shape = o.shape;
      this.base = rgb01(o.base);
      this.tip = rgb01(o.tip);
      this.shine = o.shine;
      this.fade = o.fade ?? 0.6;
      this.stripe = o.stripe ? rgb01(o.stripe) : null;
      this.spots = o.spots ? rgb01(o.spots) : null;
      this.veins = o.veins || [0, 0];
    }

    /** b = how open the flower is, 0 bud .. 1 full bloom. points are in head space (axis = +y). */
    bits(b, res) {
      const k = this.k, grown = lerp(0.55, 1.0, b);
      const L = this.L.map((x) => x * grown);
      const nu = Math.floor(clip(Math.max(...L) * res * 1.05, 5, 60));
      const nv = Math.floor(clip(2 * Math.max(...this.W) * res * 1.05, 4, 44));
      const out = Bits(k * nu * nv, false, this.shine);
      const [count, depth] = this.veins;
      const sa = new Float64Array(nu), ca = new Float64Array(nu), rho = new Float64Array(nu), hgt = new Float64Array(nu);
      const prof = new Float64Array(nu);
      for (let a = 0; a < nu; a++) {
        const u = a / (nu - 1);
        prof[a] = this.shape === "round" ? u ** 0.45 * Math.sqrt(clip(1 - u ** 5, 0, 1))
          : this.shape === "strap" ? Math.sqrt(clip(u * 6, 0, 1) * clip(1 - u ** 8, 0, 1))
            : Math.sin(Math.PI * u ** 0.7) ** 1.1;
      }
      for (let i = 0; i < k; i++) {
        // the spine of each petal: it leaves the centre at an angle and keeps bending
        const a0 = lerp(this.closed[i], this.opened[i], b), bend = lerp(this.bend0[i], this.bend1[i], b);
        let cs = 0, cc = 0;
        for (let a = 0; a < nu; a++) {
          const ang = a0 + (bend * a * L[i]) / (nu - 1);
          sa[a] = Math.sin(ang);
          ca[a] = Math.cos(ang);
          if (a > 0) { cs += sa[a]; cc += ca[a]; }
          rho[a] = this.r0[i] + (L[i] * cs) / (nu - 1);
          hgt[a] = this.h0[i] + (L[i] * cc) / (nu - 1);
        }
        const cp = Math.cos(this.phi[i]), sp = Math.sin(this.phi[i]), off = i * nu * nv;
        for (let a = 0; a < nu; a++) {
          const u = a / (nu - 1), mix = u ** this.fade;
          for (let c = 0; c < nv; c++) {
            const v = -1 + (2 * c) / (nv - 1), av = Math.abs(v);
            const lat = v * this.W[i] * prof[a];                  // across the petal
            const cupped = (this.cup[i] * lat * lat) / this.W[i]; // the cup of the petal
            const r = rho[a] - cupped * ca[a];
            const j = off + a * nv + c, p = j * 3;
            out.P[p] = r * cp - lat * sp;
            out.P[p + 1] = hgt[a] + cupped * sa[a];
            out.P[p + 2] = r * sp + lat * cp;
            out.part[j] = i;                                      // every petal is its own part
            // darker rims keep petals apart; fine veins run up the petal
            const rim = (1 - 0.4 * av ** 6) * (1 - depth * (0.5 + 0.5 * Math.cos(v * count * Math.PI)) ** 6 * (0.3 + 0.7 * u));
            let col = [0, 1, 2].map((q) => lerp(this.base[q], this.tip[q], mix) * rim);
            if (this.stripe) {                                    // a lily's painted stripe
              const w = Math.exp(-((v / 0.22) ** 2)) * (1 - u) ** 0.5 * 0.8;
              col = col.map((x, q) => lerp(x, this.stripe[q], w));
            }
            if (this.spots && Math.sin(u * 91 + v * 37 + i * 13) * Math.sin(u * 53 - v * 71) > 0.82 && u < 0.55 && av < 0.65) {
              col = this.spots.slice();                           // and its freckles
            }
            out.C[p] = col[0];
            out.C[p + 1] = col[1];
            out.C[p + 2] = col[2];
          }
        }
        sheetNormals(out, off, nu, nv);
      }
      return out;
    }
  }

  /** the petal sets that make each kind of flower. */
  function head(kind) {
    if (kind === "rose") {                          // a golden-angle spiral, tight inside, loose outside
      const sets = [];
      for (const [k0, k1] of [[0, 10], [10, 24]]) {
        const k = range(k0, k1), q = k.map((x) => x / 23);
        sets.push(new PetalSet({
          phi: k.map((x) => rad(x * 137.508)), length: q.map((x) => 0.09 + 0.17 * x),
          width: q.map((x) => 0.05 + 0.09 * x), r0: q.map((x) => 0.004 + 0.022 * x), h0: q.map((x) => -0.035 * x),
          closed: q.map((x) => 4 + 14 * x), opened: q.map((x) => 8 + 60 * x ** 1.4), bend0: q.map((x) => -3.0 + x),
          bend1: q.map((x) => -3.2 * (1 - x) ** 2 + 3.6 * x * x), cup: q.map((x) => 0.75 - 0.4 * x),
          shape: "round", base: [110, 6, 32], tip: [238, 48, 98], shine: 0.25, veins: [5, 0.07],
        }));
      }
      sets.push(new PetalSet({                      // the green sepals
        phi: range(0, 5).map((i) => rad(i * 72 + 18)), length: 0.075, width: 0.026, r0: 0.01, h0: -0.03,
        closed: 15, opened: 125, bend0: 0, bend1: 1.5, cup: 0.3, shape: "point", base: [40, 110, 40],
        tip: [82, 160, 62], shine: 0.05,
      }));
      return sets;
    }
    if (kind === "tulip") {
      const inner = [1, 1, 1, 0, 0, 0];
      return [new PetalSet({
        phi: [0, 120, 240, 60, 180, 300].map(rad), length: inner.map((x) => 0.31 - 0.02 * x),
        width: inner.map((x) => 0.155 - 0.015 * x), r0: inner.map((x) => 0.018 - 0.012 * x), h0: 0,
        closed: 5, opened: inner.map((x) => 30 - 10 * x), bend0: -1.4, bend1: -0.5, cup: 1.15, shape: "round",
        base: [255, 226, 70], tip: [255, 128, 18], shine: 0.4, fade: 0.5, veins: [11, 0.09],
      })];
    }
    if (kind === "daisy") {
      const k = range(0, 21);
      return [new PetalSet({
        phi: k.map((x) => rad((x * 360) / 21 + 4 * Math.sin(x * 2.3))), length: k.map((x) => 0.23 + 0.02 * Math.sin(x * 1.7)),
        width: 0.032, r0: 0.05, h0: 0.012, closed: 12, opened: k.map((x) => 82 + 5 * Math.sin(x * 3.1)),
        bend0: -1.2, bend1: 0.5, cup: 0.15, shape: "strap", base: [255, 236, 170], tip: [255, 250, 255],
        shine: 0.12, veins: [2, 0.16],
      })];
    }
    if (kind === "lily") {
      return [new PetalSet({
        phi: range(0, 6).map((i) => rad(i * 60 + 30)), length: 0.33, width: 0.072, r0: 0.012, h0: 0,
        closed: 6, opened: 46, bend0: -0.8, bend1: 4.4, cup: 0.45, shape: "point", base: [255, 250, 246],
        tip: [255, 140, 196], shine: 0.3, stripe: [214, 32, 122], spots: [140, 16, 72], veins: [5, 0.1],
      })];
    }
    return [];
  }

  /** the golden middle of a daisy: a low dome. */
  function disk(bl, res) {
    const n = Math.floor(clip(0.06 * res * 3, 6, 40));
    const out = Bits(n * 2 * n, false, 0.2);
    const R = 0.052, H = 0.03 * (0.4 + 0.6 * bl);
    const c0 = rgb01([214, 104, 20]), c1 = rgb01([255, 206, 42]);
    for (let i = 0; i < n; i++) {
      const a = i / (n - 1), slope = (2 * H * a) / R;
      for (let j = 0; j < 2 * n; j++) {
        const th = (TAU * j) / (2 * n), ct = Math.cos(th), st = Math.sin(th), k = (i * 2 * n + j) * 3;
        out.P[k] = R * a * ct;
        out.P[k + 1] = 0.012 + H * (1 - a * a);
        out.P[k + 2] = R * a * st;
        const nn = unit([slope * ct, 1, slope * st]);
        const grain = 0.85 + 0.15 * Math.sin(a * 40) * Math.sin(th * 9);
        for (let q = 0; q < 3; q++) {
          out.N[k + q] = nn[q];
          out.C[k + q] = lerp(c0[q], c1[q], a) * grain;
        }
      }
    }
    return out;
  }

  /** six lily stamens: thin threads with a dusty anther on each. */
  function stamens(bl, res) {
    const n = Math.floor(clip(0.22 * res * 1.5, 6, 40));
    const thread = Bits(6 * n, true, 0);
    const ang0 = rad(lerp(4, 28, bl)), up = lerp(0.5, 1, bl), cream = rgb01([232, 236, 200]);
    const tips = [];
    for (let i = 0; i < 6; i++) {
      const cp = Math.cos(rad(i * 60)), sp = Math.sin(rad(i * 60));
      let cs = 0, cc = 0;
      for (let j = 0; j < n; j++) {
        const ang = ang0 + (0.6 * j) / (n - 1);
        cs += Math.sin(ang);
        cc += Math.cos(ang);
        const rho = (0.21 * cs) / n, y = 0.01 + ((0.21 * cc) / n) * up, k = (i * n + j) * 3;
        thread.P[k] = rho * cp;
        thread.P[k + 1] = y;
        thread.P[k + 2] = rho * sp;
        for (let q = 0; q < 3; q++) thread.C[k + q] = cream[q];
        if (j === n - 1) tips.push([rho * cp, y, rho * sp]);
      }
    }
    lineTangents(thread, 6, n);
    const offs = [[0.01, 0, 0], [-0.01, 0, 0], [0, 0.008, 0], [0, 0, 0.01], [0, 0, -0.01], [0, -0.006, 0]];
    const dust = Bits(36, false, 0.1), rust = rgb01([200, 86, 26]);
    tips.forEach((tip, i) => {
      offs.forEach((o, m) => {
        const k = (i * 6 + m) * 3, nn = unit(o);
        for (let q = 0; q < 3; q++) {
          dust.P[k + q] = tip[q] + o[q];
          dust.N[k + q] = nn[q];
          dust.C[k + q] = rust[q];
        }
        dust.part[i * 6 + m] = i;
      });
    });
    return [thread, dust];
  }

  /** lavender: little violet buds spiralling up the top of the stem. */
  function florets(stem, g, size) {
    const buds = [];
    for (let i = 0; i < 22; i++) {
      const s = 0.62 + (0.38 * i) / 21, pop = smooth((g - s) / 0.08);
      if (pop > 0) buds.push([s, pop]);
    }
    if (!buds.length) return [];
    const out = Bits(buds.length * 60, false, 0.15);
    const c0 = rgb01([196, 146, 255]), c1 = rgb01([118, 72, 222]);
    buds.forEach(([s, pop], i) => {
      const [c, t] = stem.at(s);
      const k = i * 2.4;
      const side0 = unit(cross(t, [0, 0, 1])), other = cross(t, side0);
      const side = [0, 1, 2].map((q) => side0[q] * Math.cos(k) + other[q] * Math.sin(k));
      const centre = [0, 1, 2].map((q) => c[q] + side[q] * 0.028 * size);
      const r = (0.026 - (0.012 * (s - 0.62)) / 0.38) * pop * size;
      const col = [0, 1, 2].map((q) => lerp(c0[q], c1[q], (s - 0.62) / 0.38));
      for (let a = 0; a < 6; a++) {
        const la = (Math.PI * a) / 5;
        for (let b = 0; b < 10; b++) {
          const lo = (TAU * b) / 10, j = i * 60 + a * 10 + b, p = j * 3;
          const ball = [Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo)];
          for (let q = 0; q < 3; q++) {
            out.P[p + q] = centre[q] + r * ball[q];
            out.N[p + q] = ball[q];
            out.C[p + q] = col[q];
          }
          out.part[j] = i;
        }
      }
    });
    return [out];
  }

  // a tuft of grass blades around the base, drawn as thin strokes
  const BLADES = (() => {
    const rng = FY.rng(11);
    return Array.from({ length: 34 }, () => ({
      a: rng.uniform(0, TAU), r: rng.uniform(0.02, 0.26), h: rng.uniform(0.1, 0.3), lean: rng.uniform(0.25, 0.75),
    }));
  })();

  function grass(f, res) {
    const m = Math.floor(clip(0.3 * res * 1.5, 4, 24));
    const out = Bits(BLADES.length * m, true, 0);
    const c0 = rgb01([26, 86, 34]), c1 = rgb01([92, 172, 66]);
    BLADES.forEach((bl, i) => {
      const ox = Math.cos(bl.a), oz = Math.sin(bl.a), h = bl.h * f;
      for (let j = 0; j < m; j++) {
        const s = j / (m - 1), k = (i * m + j) * 3, spread = bl.r + bl.lean * h * s * s;
        out.P[k] = spread * ox;
        out.P[k + 1] = h * s;
        out.P[k + 2] = spread * oz;
        for (let q = 0; q < 3; q++) out.C[k + q] = lerp(c0[q], c1[q], s);
      }
    });
    lineTangents(out, BLADES.length, m);
    return out;
  }

  /** three unit rows (x, y, z) of a frame whose y points along `axis`. */
  function frameFor(axis) {
    const a = unit(axis);
    const ref = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const d = dot(ref, a);
    const x = unit([ref[0] - a[0] * d, ref[1] - a[1] * d, ref[2] - a[2] * d]);
    return [x, a, cross(x, a)];
  }

  /** head space -> the garden: P = tip + size * (P @ rot), and the directions turned too. */
  function place(b, tip, size, rot) {
    const [r0, r1, r2] = rot;
    const turn = (A, scale, shift) => {
      for (let k = 0; k < A.length; k += 3) {
        const x = A[k], y = A[k + 1], z = A[k + 2];
        A[k] = shift[0] + scale * (x * r0[0] + y * r1[0] + z * r2[0]);
        A[k + 1] = shift[1] + scale * (x * r0[1] + y * r1[1] + z * r2[1]);
        A[k + 2] = shift[2] + scale * (x * r0[2] + y * r1[2] + z * r2[2]);
      }
    };
    turn(b.P, size, tip);
    turn(b.N, 1, [0, 0, 0]);
    turn(b.T, 1, [0, 0, 0]);
  }

  /** grows the flowers over time, and hands back all their points for a moment. */
  FY.Garden = class Garden {
    constructor() {
      this.flowers = GARDEN.map((spec, i) => ({
        ...spec,
        stem: new Stem(spec.base, spec.top, spec.kind === "lavender" ? 0.012 : spec.kind === "rose" ? 0.019 : 0.016),
        sets: head(spec.kind),
      }));
      this.phases = [0, ...GARDEN.map((_, i) => i * 1.7)];    // index 0: the grass
      this.done = Math.max(...GARDEN.map((f) => f.start)) + GROW * 0.85 + OPEN;
      this.cache = null;
      this.kept = new Map();                        // finished flowers don't need rebuilding
    }

    stage(f, t) {
      return [easeOut((t - f.start) / GROW), smooth((t - f.start - GROW * 0.85) / OPEN)];
    }

    /** every point in the garden at time t, plus the tips still growing (for sparkles). */
    points(t, res) {
      if (t >= this.done && this.cache && this.cache.res === res) return [this.cache.pts, []];
      const tuft = smooth(t / 1.4), gk = `grass|${res}`;
      if (tuft < 1 || !this.kept.has(gk)) this.kept.set(gk, [grass(tuft, res)]);
      const bits = [...this.kept.get(gk)], phase = [0], tips = [];
      this.flowers.forEach((f, fi) => {
        const [g, b] = this.stage(f, Math.max(t, 0));
        if (g <= 0.01) return;
        const start = bits.length, key = `${f.kind}|${res}`;
        if (g >= 1 && b >= 1 && this.kept.has(key)) {
          for (const p of this.kept.get(key)) { bits.push(p); phase.push(fi + 1); }
          return;
        }
        const stem = f.stem;
        bits.push(stem.bits(g, res));
        const wide = f.kind === "tulip" ? 0.12 : 0.095, rise = f.kind === "tulip" ? 68 : 32;
        f.leaves.forEach(([at, turn, length], n) => {
          const open = smooth((g - at) / 0.25), lk = `${f.kind}|${n}|${res}`;
          if (open >= 1 && this.kept.has(lk)) bits.push(this.kept.get(lk));   // an open leaf never changes again
          else if (open > 0) {
            const lf = leaf(stem.at(at)[0], rad(turn), rise, length, wide, 1.1, open, res);
            bits.push(lf);
            if (open >= 1) this.kept.set(lk, lf);
          }
        });
        const [tip, tangent] = stem.at(g);
        if (g < 0.995) tips.push(tip);
        if (f.kind === "lavender") bits.push(...florets(stem, g, f.size));
        else {
          const size = f.size * (0.3 + 0.7 * smooth((g - 0.2) / 0.8));
          const ol = Math.hypot(f.top[0], f.top[2]);
          const out = ol > 0.1 ? [f.top[0] / ol, 0, f.top[2] / ol] : [0, 0, 1];
          const lean = rad(f.tilt);
          const rot = frameFor([0, 1, 2].map((q) => out[q] * Math.sin(lean) + (q === 1 ? Math.cos(lean) : 0) + tangent[q] * 0.3));
          const parts = f.sets.map((p) => p.bits(b, res * size));
          if (f.kind === "daisy" && b > 0) parts.push(disk(b, res * size));
          if (f.kind === "lily" && b > 0.15) parts.push(...stamens(b, res * size));
          for (const p of parts) {
            place(p, tip, size, rot);
            bits.push(p);
          }
        }
        if (g >= 1 && b >= 1) this.kept.set(key, bits.slice(start));
        for (let i = start; i < bits.length; i++) phase.push(fi + 1);
      });

      let total = 0;
      for (const p of bits) total += p.n;
      const pts = {
        n: total, P: new Float32Array(3 * total), N: new Float32Array(3 * total), T: new Float32Array(3 * total),
        C: new Float32Array(3 * total), part: new Int32Array(total), thin: new Uint8Array(total),
        shine: new Float32Array(total), phase: new Uint8Array(total),
      };
      let at = 0, base = 0;
      bits.forEach((p, i) => {                       // one number per petal / leaf / stem
        pts.P.set(p.P, at * 3);
        pts.N.set(p.N, at * 3);
        pts.T.set(p.T, at * 3);
        pts.C.set(p.C, at * 3);
        let top = -1;
        for (let j = 0; j < p.n; j++) {
          pts.part[at + j] = p.part[j] + base;
          if (p.part[j] > top) top = p.part[j];
        }
        base += p.n ? top + 1 : 1;
        pts.thin.fill(p.thin, at, at + p.n);
        pts.shine.fill(p.shine, at, at + p.n);
        pts.phase.fill(phase[i], at, at + p.n);
        at += p.n;
      });
      if (t >= this.done) this.cache = { res, pts };
      return [pts, tips];
    }
  };

  // ── light, camera, glyphs ──────────────────────────────────────────────────
  const KEY = unit([-0.55, 0.65, 0.55]);          // main light: up, left, in front
  const FILL = unit([0.7, 0.1, 0.4]);
  const HALF = unit([KEY[0], KEY[1], KEY[2] + 1]);
  const RAMP = Array.from(" .,:;=+*?%#&8$@", (c) => c.codePointAt(0));   // light to dense
  const LINE = Array.from("-/|\\", (c) => c.codePointAt(0));              // by the slope of a thin stroke

  /** the camera, pointed at the garden and fitted to its pane. */
  FY.View = class View {
    constructor(ax, ay, aw, ah, cell, room = [1, 5]) {
      Object.assign(this, { ax, ay, aw, ah, cell });
      const top = room[0], tall = Math.max(4, ah - room[1] - top);
      this.k = Math.min((aw * 0.94) / SPAN_X, (tall * cell) / SPAN_Y);   // cells per unit, sideways
      this.cx = aw / 2;
      this.cy = top + tall / 2;
      this.res = Math.min(1.6 * this.k, 90);       // points per unit: just enough to fill the cells
      const rng = FY.rng(3);
      this.grain = Float32Array.from({ length: ah * aw }, () => rng.uniform(-0.45, 0.45));
      const S = aw * 2 * ah * 4;
      this.depthS = new Float32Array(S);
      this.ownerS = new Int32Array(S);
      this.depthT = new Float32Array(S);
      this.ownerT = new Int32Array(S);
      this.depth = new Float32Array(aw * ah);
      this.cap = 0;
      this.m8 = new Float32Array(8);
      this.ow = new Int32Array(8);
    }

    matrix(spin) {                                  // rot_x(TILT) @ rot_y(spin)
      const cx = Math.cos(TILT), sx = Math.sin(TILT), cy = Math.cos(spin), sy = Math.sin(spin);
      return [[cy, 0, sy], [sx * sy, cx, -sx * cy], [-cx * sy, sx, cx * cy]];
    }

    /** one point -> [column, row, depth] inside the pane. */
    project(x, y, z, M) {
      y -= AIM_Y;
      const qx = M[0][0] * x + M[0][1] * y + M[0][2] * z;
      const qy = M[1][0] * x + M[1][1] * y + M[1][2] * z;
      const qz = M[2][0] * x + M[2][1] * y + M[2][2] * z;
      const f = DIST / (DIST - qz);
      return [this.cx + qx * f * this.k, this.cy - (qy * f * this.k) / this.cell, DIST - qz];
    }

    grow(n) {
      if (this.cap >= n) return;
      const c = (this.cap = Math.ceil(n * 1.25));
      Object.assign(this, {
        col: new Float32Array(c), row: new Float32Array(c), zz: new Float32Array(c), lit: new Float32Array(c),
        rgb: new Float32Array(3 * c), face: new Float32Array(c), nx: new Float32Array(c), ny: new Float32Array(c),
        tx: new Float32Array(c), ty: new Float32Array(c),
      });
    }

    /** paint the garden into the screen; returns the depth of every cell (Infinity = sky). */
    draw(scr, pts, t, spin, phases) {
      const n = pts.n, { aw, ah, k, cell, cx, cy } = this;
      this.grow(n);
      const { col, row, zz, lit, rgb, face, nx, ny, tx, ty } = this;
      const M = this.matrix(spin);
      const [m0, m1, m2] = M;
      const sway = phases.map((ph) => [Math.sin(1.25 * t + ph), Math.cos(1.05 * t + ph)]);   // a breeze
      const { P, N, T, C, shine, phase } = pts;
      for (let i = 0; i < n; i++) {
        const p = i * 3;
        const y = P[p + 1], s = 0.02 * y * y, w = sway[phase[i]];
        const x = P[p] + s * w[0], z = P[p + 2] + 0.7 * s * w[1], yy = y - AIM_Y;
        const qx = m0[0] * x + m0[1] * yy + m0[2] * z;
        const qy = m1[0] * x + m1[1] * yy + m1[2] * z;
        const qz = m2[0] * x + m2[1] * yy + m2[2] * z;
        const f = DIST / (DIST - qz);
        col[i] = cx + qx * f * k;
        row[i] = cy - (qy * f * k) / cell;
        zz[i] = DIST - qz;
        // light: two lamps, a shine, and a rim of light on the edges
        const a = N[p], b = N[p + 1], c = N[p + 2];
        const ax = m0[0] * a + m0[1] * b + m0[2] * c, ay = m1[0] * a + m1[1] * b + m1[2] * c, az = m2[0] * a + m2[1] * b + m2[2] * c;
        nx[i] = ax;
        ny[i] = ay;
        tx[i] = m0[0] * T[p] + m0[1] * T[p + 1] + m0[2] * T[p + 2];
        ty[i] = m1[0] * T[p] + m1[1] * T[p + 1] + m1[2] * T[p + 2];
        const fc = Math.abs(az), sg = az < 0 ? -1 : 1;
        face[i] = fc;
        const ux = ax * sg, uy = ay * sg, uz = az * sg;
        const spec = shine[i] * Math.max(0, ux * HALF[0] + uy * HALF[1] + uz * HALF[2]) ** 24;
        const l = 0.26 + 0.66 * Math.max(0, ux * KEY[0] + uy * KEY[1] + uz * KEY[2])
          + 0.26 * Math.max(0, ux * FILL[0] + uy * FILL[1] + uz * FILL[2]) + 0.38 * (1 - fc) ** 2 + spec;
        lit[i] = l;
        const gain = 0.35 + 0.8 * l, glint = 0.55 * spec;
        rgb[p] = clip(C[p] * gain + glint, 0, 1);
        rgb[p + 1] = clip(C[p + 1] * gain + glint, 0, 1);
        rgb[p + 2] = clip(C[p + 2] * gain + glint, 0, 1);
      }

      // every cell is split into 2x4 square samples, and the nearest point in each sample wins.
      // stems and grass are laid down two samples wide so they don't vanish
      const W = aw * 2, H = ah * 4, depth = this.depthS, owner = this.ownerS;
      depth.fill(Infinity);
      owner.fill(-1);
      const thin = pts.thin;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          if (pass === 1 && !thin[i]) continue;
          const xi = Math.floor(col[i] * 2) + pass, yi = Math.floor(row[i] * 4);
          if (xi < 0 || xi >= W || yi < 0 || yi >= H) continue;
          const q = yi * W + xi;
          if (zz[i] <= depth[q]) {
            depth[q] = zz[i];
            owner[q] = i;
          }
        }
      }
      // close pinholes: an empty sample between two full ones copies the nearer neighbour
      const d2 = this.depthT, o2 = this.ownerT;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        o2.set(owner);
        d2.set(depth);
        for (let y = dy; y < H - dy; y++) {
          for (let x = dx; x < W - dx; x++) {
            const q = y * W + x;
            if (o2[q] >= 0) continue;
            const qa = q - dy * W - dx, qb = q + dy * W + dx;
            if (o2[qa] < 0 || o2[qb] < 0) continue;
            const first = d2[qa] <= d2[qb];
            owner[q] = first ? o2[qa] : o2[qb];
            depth[q] = first ? d2[qa] : d2[qb];
          }
        }
      }

      // letters: each cell takes the glyph whose shape matches its front piece best
      const part = pts.part, m8 = this.m8, ow = this.ow, out = this.depth;
      for (let cyy = 0, c = 0; cyy < ah; cyy++) {
        for (let cxx = 0; cxx < aw; cxx++, c++) {
          let front = -1, near = Infinity;
          for (let j = 0; j < 8; j++) {
            const q = (cyy * 4 + (j >> 1)) * W + cxx * 2 + (j & 1);
            ow[j] = owner[q];
            if (owner[q] >= 0 && depth[q] < near) {
              near = depth[q];
              front = j;
            }
          }
          out[c] = near;
          if (front < 0) continue;
          const fo = ow[front], fp = part[fo];
          let cov = 0, r = 0, g = 0, b = 0, light = 0;
          for (let j = 0; j < 8; j++) {
            const o = ow[j];
            if (o >= 0 && part[o] === fp) {
              m8[j] = 1;
              cov++;
              r += rgb[o * 3];
              g += rgb[o * 3 + 1];
              b += rgb[o * 3 + 2];
              light += lit[o];
            } else m8[j] = 0;
          }
          r /= cov;
          g /= cov;
          b /= cov;
          const tone = clip((light / cov - 0.15) / 0.8, 0, 1) ** 0.75;
          let glyph = RAMP[clip(Math.round(tone * (RAMP.length - 1) + this.grain[c]), 1, RAMP.length - 1)];
          if (cov < 8) glyph = FY.CODES[FY.match8(m8, 0.78)];
          if (thin[fo] || face[fo] < 0.12) {              // stems, grass and sheets seen edge-on: a stroke
            const sx = thin[fo] ? tx[fo] : -ny[fo], sy = thin[fo] ? ty[fo] : nx[fo];
            const slope = mod((Math.atan2(sy, sx) * 180) / Math.PI + 202.5, 180);
            glyph = LINE[Math.floor(slope / 45) % 4];
            r *= 1.12;
            g *= 1.12;
            b *= 1.12;
          }
          const at = (this.ay + cyy) * scr.w + this.ax + cxx;
          scr.ch[at] = glyph;
          scr.fg[at] = pack(r, g, b);
        }
      }
      return out;
    }
  };

  // ── the sky ────────────────────────────────────────────────────────────────
  /** a thin crescent up in the corner. */
  FY.moon = function (scr, ax, ay, aw, ah, cell) {
    const R = clip(aw * 0.07, 3, 8);
    const mx = ax + aw * 0.17, my = ay + ah * 0.12 + 1;
    const LOOK = Array.from(":*%&@", (c) => c.codePointAt(0));
    for (let y = Math.trunc(my - R / cell) - 1; y < Math.trunc(my + R / cell) + 2; y++) {
      for (let x = Math.trunc(mx - R) - 1; x < Math.trunc(mx + R) + 2; x++) {
        if (y < ay || y >= ay + ah || x < ax || x >= ax + aw || scr.ch[y * scr.w + x] !== SPACE) continue;
        const dx = (x + 0.5 - mx) / R, dy = ((y + 0.5 - my) * cell) / R;
        const inside = smooth((1 - Math.hypot(dx, dy)) * R * 1.5);
        const shadow = smooth((Math.hypot(dx - 0.42, dy + 0.12) - 0.9) * R * 1.5);
        if (inside * shadow <= 0.5) continue;
        const shade = clip(0.55 - dx, 0, 1), k = 0.55 + 0.45 * shade;
        scr.ch[y * scr.w + x] = LOOK[clip(Math.trunc(shade * 5), 0, 4)];
        scr.fg[y * scr.w + x] = pack(0.96 * k, 0.92 * k, 0.74 * k);
      }
    }
  };

  /** shooting stars, fireflies, and the glitter thrown off by growing stems. */
  FY.Sky = class Sky {
    constructor() {
      const rng = (this.rng = FY.rng(7));
      this.comet = null;
      this.nextComet = 3.0;
      this.fly = Array.from({ length: 16 }, () => ({
        r: rng.uniform(0.35, 0.95), y: rng.uniform(0.25, 1.6), w: rng.uniform(0.15, 0.4) * rng.choice([-1, 1]),
        a: rng.uniform(0, TAU), blink: rng.uniform(0, TAU),
      }));
      this.dust = [];
    }

    sparkle(tips, dt) {
      const rng = this.rng;
      for (const p of tips) {
        for (let k = 0; k < 3; k++) {
          this.dust.push({ x: p[0], y: p[1], z: p[2], vx: rng.normal(0, 0.18), vy: rng.normal(0, 0.18) + 0.25, vz: rng.normal(0, 0.18), age: 0 });
        }
      }
      if (this.dust.length > 260) this.dust = this.dust.slice(-260);
      const drag = 1 - 0.8 * dt;
      for (const d of this.dust) {
        d.vx *= drag;
        d.vy = d.vy * drag - 0.35 * dt;
        d.vz *= drag;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.z += d.vz * dt;
        d.age += dt;
      }
      this.dust = this.dust.filter((d) => d.age < 1.3);
    }

    draw(scr, view, depth, t, spin) {
      const { ax, ay, aw, ah } = view, rng = this.rng;
      if (!this.comet && t > this.nextComet) {     // a shooting star now and then
        const go = rng.choice([-1, 1]);
        this.comet = [t, ax + aw * rng.uniform(0.2, 0.8), ay + ah * rng.uniform(0.05, 0.3), go * rng.uniform(28, 40), rng.uniform(9, 14)];
      }
      if (this.comet) {
        const [t0, x0, y0, vx, vy] = this.comet, age = t - t0;
        for (let k = 0; k < 14; k++) {
          const a = age - k * 0.018;
          const x = Math.trunc(x0 + vx * a), y = Math.trunc(y0 + ((vy * a) / view.cell) * 0.7);
          if (a < 0 || x < ax || x >= ax + aw || y < ay || y >= ay + ah || scr.ch[y * scr.w + x] !== SPACE) continue;
          const f = Math.max(0, 1 - k / 14) * Math.max(0, 1 - age / 1.1);
          scr.ch[y * scr.w + x] = k === 0 ? 42 : k < 5 ? (vx > 0 ? 92 : 47) : 46;
          scr.fg[y * scr.w + x] = pack(0.85 * f, 0.9 * f, f);
        }
        if (age > 1.1) {
          this.comet = null;
          this.nextComet = t + rng.uniform(4, 8);
        }
      }
      // fireflies drifting round the garden, and fresh glitter
      const flies = this.fly.map((f) => {
        const ang = f.a + f.w * t;
        return [f.r * Math.cos(ang), f.y + 0.08 * Math.sin(t * 0.9 + f.blink), f.r * Math.sin(ang), 0.5 + 0.5 * Math.sin(t * 2.2 + f.blink)];
      });
      this.dots(scr, view, depth, flies, 0, [1.0, 0.9, 0.45]);
      if (this.dust.length) {
        this.dots(scr, view, depth, this.dust.map((d) => [d.x, d.y, d.z, 1 - d.age / 1.3]), spin, [1.0, 0.95, 0.85]);
      }
    }

    dots(scr, view, depth, list, spin, tint) {
      const M = view.matrix(spin);
      for (const [x, y, z, b] of list) {
        if (b <= 0.15) continue;
        const [c, r, zz] = view.project(x, y, z, M);
        const ci = Math.floor(c), ri = Math.floor(r);
        if (ci < 0 || ci >= view.aw || ri < 0 || ri >= view.ah || !(zz < depth[ri * view.aw + ci])) continue;
        const at = (view.ay + ri) * scr.w + view.ax + ci, k = 0.35 + 0.65 * b;
        scr.ch[at] = b > 0.75 ? 42 : b > 0.45 ? 43 : 46;
        scr.fg[at] = pack(tint[0] * k, tint[1] * k, tint[2] * k);
      }
    }
  };
})();
