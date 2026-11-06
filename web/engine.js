/* engine.js - the screen, the glyphs, and the pieces every scene shares.
   a web port of art.py from terminal-art: the same glyph table and the same maths,
   drawn onto a canvas instead of a terminal. */
"use strict";

const FY = (window.FY = {});
FY.TAU = Math.PI * 2;

// ── glyphs ──────────────────────────────────────────────────────────────────
// how much of each of the 4x8 sub-cells a character covers (0-f), row by row,
// measured from a monospace font. matching the picture against these is what
// puts a "/" on a slanted edge, a "_" on a floor and an "@" in solid ink.
const GLYPHS = [
  [" ", "00000000000000000000000000000000"], ["`", "15000310000000000000000000000000"],
  [".", "00000000000000000530053000000000"], ["'", "03300650011000000000000000000000"],
  ["-", "00000000000019900000000000000000"], [":", "00000000076000000330043000000000"],
  ["_", "00000000000000000000000088880000"], [",", "00000000000000000430057028200000"],
  ['"', "15502990011000000000000000000000"], ["^", "01100870546300000000000000000000"],
  ["~", "00000000110089691041000000000000"], [";", "00000000076000000430058018200000"],
  ["<", "00000020058049000760004000000000"], [">", "00001200184000930760240000000000"],
  ["!", "03200650054005400320043000000000"], ["=", "00000000355223314884000000000000"],
  ["/", "00220080017007200900540030000000"], ["*", "02203992388202200000000000000000"],
  ["\\", "32002800091003600080006300120000"], ["+", "0000000005407bb60540022000000000"],
  ["?", "072001a1029209300500061000000000"], ["|", "05400540054005400540054005400000"],
  [")", "06000740009000900090036009000000"], ["(", "005004600a000a000b00083001800000"],
  ["]", "07500080008000800080008007900000"], ["7", "23314797008102800920160000000000"],
  ["}", "26100450026000b30260036029300000"], ["{", "0161063007204b000820072004910000"],
  ["[", "06600a000a000a000a000a000b600000"], ["#", "011009615bb6388168a3224000000000"],
  ["8", "02105894578339a29247287100000000"], ["%", "45057963677008754579507400000000"],
  ["0", "011049a390899a3a8456187000000000"], ["$", "00504ab1875009b218575c7004000000"],
  ["&", "174064904b60887891b6395700000000"], ["@", "04615418758879888998754256600000"],
];
const NG = (FY.NG = GLYPHS.length);
FY.CHARS = GLYPHS.map((g) => g[0]);
FY.CODES = Int32Array.from(FY.CHARS, (c) => c.codePointAt(0));
const SHAPE = new Float32Array(NG * 32);
const SHAPE_E = new Float32Array(NG);
const COVER = new Float32Array(NG);
GLYPHS.forEach(([, bits], g) => {
  for (let j = 0; j < 32; j++) {
    const v = parseInt(bits[j], 16) / 15;
    SHAPE[g * 32 + j] = v;
    SHAPE_E[g] += v * v;
    COVER[g] += v / 32;
  }
});
// the glyphs that read as an even tone, light to dense: TONE maps 0-255 to the nearest one
const TONE = (FY.TONE = new Uint8Array(256));
{
  const ramp = Array.from(" .-:;~=*+?{[#8%0$&@", (c) => FY.CHARS.indexOf(c));
  const top = Math.max(...COVER);
  for (let i = 0; i < 256; i++) {
    let best = 0, gap = Infinity;
    for (const g of ramp) {
      const d = Math.abs(COVER[g] - (top * i) / 255);
      if (d < gap) { gap = d; best = g; }
    }
    TONE[i] = best;
  }
}
// the same shapes at 2x4 (the garden samples every cell 2 across, 4 down)
const GLYPH8 = new Float32Array(NG * 8);
const GLYPH8_E = new Float32Array(NG);
for (let g = 0; g < NG; g++) {
  for (let rp = 0; rp < 4; rp++) {
    for (let cp = 0; cp < 2; cp++) {
      let s = 0;
      for (let rr = 0; rr < 2; rr++) for (let cc = 0; cc < 2; cc++) s += SHAPE[g * 32 + (rp * 2 + rr) * 4 + cp * 2 + cc];
      GLYPH8[g * 8 + rp * 2 + cp] = s / 4;
      GLYPH8_E[g] += (s / 4) * (s / 4);
    }
  }
}

/** the glyph whose 4x8 shape fits these 32 coverages best (scaled first by k). */
FY.match32 = function (P, k) {
  let best = 0, low = Infinity;
  for (let g = 0; g < NG; g++) {
    let dot = 0;
    const o = g * 32;
    for (let j = 0; j < 32; j++) dot += SHAPE[o + j] * P[j];
    const v = SHAPE_E[g] - 2 * k * dot;
    if (v < low) { low = v; best = g; }
  }
  return best;
};

/** the same at 2x4: m holds 8 coverages. */
FY.match8 = function (m, k) {
  let best = 0, low = Infinity;
  for (let g = 0; g < NG; g++) {
    let dot = 0;
    const o = g * 8;
    for (let j = 0; j < 8; j++) dot += GLYPH8[o + j] * m[j];
    const v = GLYPH8_E[g] - 2 * k * dot;
    if (v < low) { low = v; best = g; }
  }
  return best;
};

// ── numbers and colours ─────────────────────────────────────────────────────
FY.clip = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
FY.mod = (a, m) => ((a % m) + m) % m;                       // python's %, never negative
FY.lerp = (a, b, t) => a + (b - a) * t;
FY.smoothstep = (a, b, x) => {
  const t = FY.clip((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const q8 = (v) => {
  v = v > 0 ? (v < 1 ? v : 1) : 0;
  return Math.min(255, ((((v * 255) | 0) + 4) >> 3) << 3);  // 32 steps a channel, like art.py
};
/** float r, g, b (0-1) -> one packed colour. */
FY.pack = (r, g, b) => (q8(r) << 16) | (q8(g) << 8) | q8(b);
/** a packed colour scaled towards black. */
FY.dim = (c, f) => {
  if (f >= 1) return c;
  return ((((c >> 16) & 255) * f) << 16) | ((((c >> 8) & 255) * f) << 8) | (((c & 255) * f) | 0);
};
FY.fade = (c, f) => ((((c >> 16) & 255) * f) << 16) | ((((c >> 8) & 255) * f) << 8) | (((c & 255) * f) | 0);

/** a small seeded random source, so the stars and petals land the same way every time. */
FY.rng = function (seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random: next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor((hi - lo) * next()),      // lo .. hi-1
    normal: (mu, sd) => mu + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(FY.TAU * next()),
    choice: (list) => list[Math.floor(next() * list.length)],
  };
};

// ── the screen: a grid of (glyph, colour) ───────────────────────────────────
const SPACE = (FY.SPACE = 32);
FY.Screen = class Screen {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ch = new Int32Array(w * h).fill(SPACE);
    this.fg = new Int32Array(w * h);
  }
  clear() {
    this.ch.fill(SPACE);
    this.fg.fill(0);
  }
  put(x, y, text, fg) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    const chars = Array.from(text);
    const n = Math.min(chars.length, this.w - x);
    const at = y * this.w + x;
    for (let i = 0; i < n; i++) {
      this.ch[at + i] = chars[i].codePointAt(0);
      this.fg[at + i] = typeof fg === "number" ? fg : fg[i];
    }
  }
  free(x, y) {
    return x >= 0 && x < this.w && y >= 0 && y < this.h && this.ch[y * this.w + x] === SPACE;
  }
};

// ── drawing the screen onto a canvas ────────────────────────────────────────
// every glyph is drawn once, in white, into an atlas. each frame copies the glyphs
// cell by cell, then one pass tints them: a tiny picture with one pixel per cell,
// stretched over the whole canvas, keeps only where there is ink ("source-in").
const FONT = 'Consolas, "Cascadia Mono", Menlo, "SF Mono", "DejaVu Sans Mono", "Roboto Mono", ' +
  '"Noto Sans Mono", "Liberation Mono", "Courier New", monospace';
const AS_TEXT = new Set([0x2665, 0x266a, 0x266b, 0x2022]);   // never as emoji

FY.Renderer = class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.atlas = document.createElement("canvas");
    this.actx = this.atlas.getContext("2d");
    this.tint = document.createElement("canvas");
    this.tctx = this.tint.getContext("2d");
    this.cols = this.rows = this.cw = 0;
  }

  /** pick the cell size for this window. returns true when the grid changed. */
  fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth, vh = window.innerHeight;
    let cell = vh > vw * 1.1 ? vw / 70 : vh / 88;               // phones: ~70 across; screens: ~44 down
    cell = FY.clip(cell, 4.5, 11);
    const cw = Math.max(4, Math.round(cell * dpr)), chh = cw * 2;
    const cols = Math.max(24, Math.floor((vw * dpr) / cw));
    const rows = Math.max(12, Math.floor((vh * dpr) / chh));
    if (cols === this.cols && rows === this.rows && cw === this.cw) return false;
    Object.assign(this, { dpr, cw, chh, cols, rows });
    const c = this.canvas;
    c.width = cols * cw;
    c.height = rows * chh;
    c.style.width = `${c.width / dpr}px`;
    c.style.height = `${c.height / dpr}px`;
    const a = this.actx;
    a.font = `100px ${FONT}`;
    const m100 = a.measureText("M");
    const advance = m100.width / 100 || 0.6;                    // one letter's width, per px of font
    const tall = ((m100.fontBoundingBoxAscent || 80) + (m100.fontBoundingBoxDescent || 22)) / 100;
    this.px = Math.min(cw / advance, chh / tall);               // as wide as a cell, if it fits its height
    a.font = `${this.px}px ${FONT}`;
    const m = a.measureText("M");
    const asc = m.fontBoundingBoxAscent || this.px * 0.8;
    const desc = m.fontBoundingBoxDescent || this.px * 0.22;
    this.base = Math.round((chh - (asc + desc)) / 2 + asc);
    this.atlas.width = 32 * cw;
    this.atlas.height = 8 * chh;
    this.slots = new Map();
    this.tint.width = cols;
    this.tint.height = rows;
    this.paint = this.tctx.createImageData(cols, rows);
    return true;
  }

  slot(code) {
    let s = this.slots.get(code);
    if (s !== undefined) return s;
    s = this.slots.size;
    if (s >= 256) return this.slots.get(63) || 0;
    const { cw, chh } = this;
    const x = (s % 32) * cw, y = Math.floor(s / 32) * chh;
    const a = this.actx;
    a.save();
    a.beginPath();
    a.rect(x, y, cw, chh);
    a.clip();
    a.font = `${this.px}px ${FONT}`;
    a.fillStyle = "#fff";
    a.textAlign = "center";
    a.textBaseline = "alphabetic";
    const text = String.fromCodePoint(code) + (AS_TEXT.has(code) ? "︎" : "");
    const w = a.measureText(text).width;
    a.translate(x + cw / 2, y + this.base);
    if (w > cw * 1.05) a.scale(cw / w, 1);                     // a wide fallback glyph: squeeze it in
    a.fillText(text, 0, 0);
    a.restore();
    this.slots.set(code, s);
    return s;
  }

  draw(scr) {
    const { ctx, cw, chh, cols, rows } = this;
    const W = cols * cw, H = rows * chh;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    const px = this.paint.data, ch = scr.ch, fg = scr.fg;
    for (let y = 0, i = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++, i++) {
        const c = ch[i], o = i * 4;
        if (c === SPACE || fg[i] === 0) {
          px[o + 3] = 0;
          continue;
        }
        const s = this.slot(c);
        ctx.drawImage(this.atlas, (s % 32) * cw, Math.floor(s / 32) * chh, cw, chh, x * cw, y * chh, cw, chh);
        const f = fg[i];
        px[o] = (f >> 16) & 255;
        px[o + 1] = (f >> 8) & 255;
        px[o + 2] = f & 255;
        px[o + 3] = 255;
      }
    }
    this.tctx.putImageData(this.paint, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tint, 0, 0, cols, rows, 0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }
};

// ── stars ───────────────────────────────────────────────────────────────────
const TINTS = [[1.0, 1.0, 1.0], [1.0, 0.78, 0.88], [0.78, 0.86, 1.0]];

/** a slow twinkle in the empty black, like the sky behind the rose. */
FY.Stars = class Stars {
  place(w, h) {
    const rng = FY.rng(5);
    const n = Math.max(8, Math.floor((w * h) / 55));
    this.n = n;
    this.x = new Int32Array(n);
    this.y = new Int32Array(n);
    this.phase = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.colour = new Int32Array(n * 7);
    this.glint = new Uint8Array(n);
    this.arm = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = rng.int(0, w);
      this.y[i] = rng.int(0, h);
      this.phase[i] = rng.uniform(0, 6.283);
      this.speed[i] = rng.uniform(0.5, 2.2);
      const t = TINTS[rng.int(0, 3)];
      for (let s = 0; s < 7; s++) {
        const k = 0.18 + (0.72 * s) / 6;                      // brightness in 7 steps
        this.colour[i * 7 + s] = FY.pack(t[0] * k, t[1] * k, t[2] * k);
      }
      this.glint[i] = rng.random() < 0.1 ? 1 : 0;
      this.arm[i] = FY.pack(t[0] * 0.35, t[1] * 0.35, t[2] * 0.35);
    }
    this.size = `${w}x${h}`;
  }

  draw(scr, x0, y0, w, h, t) {
    if (this.size !== `${w}x${h}`) this.place(w, h);
    const cross = [];
    for (let i = 0; i < this.n; i++) {
      const step = Math.round((0.5 + 0.5 * Math.sin(this.speed[i] * t + this.phase[i])) * 6);
      if (step < 3) continue;
      const x = this.x[i] + x0, y = this.y[i] + y0, at = y * scr.w + x;
      if (scr.ch[at] !== SPACE) continue;
      scr.ch[at] = step === 6 ? 42 : step === 5 ? 43 : 46;      // * + .
      scr.fg[at] = this.colour[i * 7 + step];
      if (this.glint[i] && step === 6) cross.push(i);
    }
    for (const i of cross) {                                    // a little cross of light
      const x = this.x[i] + x0, y = this.y[i] + y0;
      for (const [dx, dy, c] of [[-1, 0, 45], [1, 0, 45], [0, -1, 124], [0, 1, 124]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= x0 && xx < x0 + w && yy >= y0 && yy < y0 + h && scr.ch[yy * scr.w + xx] === SPACE) {
          scr.ch[yy * scr.w + xx] = c;
          scr.fg[yy * scr.w + xx] = this.arm[i];
        }
      }
    }
  }
};

// ── the edit as glyph art ───────────────────────────────────────────────────
// each cell looks at its own patch of the frame. the colour of the page is wiped
// to black and whatever is left becomes glyphs: solid ink turns into dense letters,
// edges get the glyph whose shape fits them best.
function glow(r, g, b, pop) {
  const v = Math.max(r, g, b);
  const target = 0.42 + 0.58 * Math.pow(Math.max(v, pop), 0.8);
  const gain = target / Math.max(v, 0.12);
  const lift = Math.max(0, target - v * gain);
  r = r * gain + lift;
  g = g * gain + lift;
  b = b * gain + lift;
  const grey = (r + g + b) / 3;
  return FY.pack(grey + (r - grey) * 1.25, grey + (g - grey) * 1.25, grey + (b - grey) * 1.25);
}

/** the rose look: the page goes black and everything on it turns to glyphs. */
FY.Ink = class Ink {
  constructor() {
    this.graphic = 1.0;                       // 1 = flat graphic frame, 0 = photo (smoothed)
    this.page = [0, 0, 0];
    this.span = [0, 1];
    this.n = 0;
    this.counts = new Int32Array(4096);
    this.fine = new Float32Array(32);
  }

  /** coverage of one sample, and its distance from the page colour (dist[0]). */
  cover(r, g, b, out) {
    const gr = this.graphic;
    let p = 0, d = -1;
    if (gr > 0.02) {
      const dr = r - this.page[0], dg = g - this.page[1], db = b - this.page[2];
      d = Math.sqrt(dr * dr + dg * dg + db * db);
      p = FY.smoothstep(0.08, 0.55, d);
    }
    if (gr < 0.98) {
      const [lo, hi] = this.span;
      const shade = FY.clip((0.299 * r + 0.587 * g + 0.114 * b - lo) / (hi - lo), 0, 1);
      p = d < 0 ? shade : gr * p + (1 - gr) * shade;
    }
    out[0] = d;
    return p;
  }

  /** px: the frame's RGBA, cols*4 wide and rows*8 tall. fills glyph (index) and fg (colour) per cell. */
  run(px, cols, rows, glyph, fg) {
    const n = cols * rows, W = cols * 4;
    if (n !== this.n) {
      this.n = n;
      const rng = FY.rng(22);
      this.grain = Float32Array.from({ length: n }, () => rng.uniform(0.72, 1.0));
      this.R = new Float32Array(n * 8);
      this.G = new Float32Array(n * 8);
      this.B = new Float32Array(n * 8);
      this.lum = new Float32Array(n * 3);
    }
    const { R, G, B } = this;
    // a 2x4 sample of every cell: each one the average of a 2x2 block of pixels
    for (let cy = 0, c = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++, c++) {
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const x = cx * 4 + sx * 2, y = cy * 8 + sy * 2;
            const a = (y * W + x) * 4, b = a + W * 4, j = c * 8 + sy * 2 + sx;
            R[j] = (px[a] + px[a + 4] + px[b] + px[b + 4]) / 1020;
            G[j] = (px[a + 1] + px[a + 5] + px[b + 1] + px[b + 5]) / 1020;
            B[j] = (px[a + 2] + px[a + 6] + px[b + 2] + px[b + 6]) / 1020;
          }
        }
      }
    }
    // the page: the most common colour (from a sparse sample)
    const counts = this.counts;
    counts.fill(0);
    let seen = 0;
    for (let c = 0; c < n; c += 2) {
      for (let j = 0; j < 8; j += 2) {
        const k = c * 8 + j;
        counts[(((R[k] * 15.99) | 0) << 8) | (((G[k] * 15.99) | 0) << 4) | ((B[k] * 15.99) | 0)]++;
        seen++;
      }
    }
    let top = 0;
    for (let k = 1; k < 4096; k++) if (counts[k] > counts[top]) top = k;
    let pr = 0, pg = 0, pb = 0;
    for (let c = 0; c < n; c += 2) {
      for (let j = 0; j < 8; j += 2) {
        const k = c * 8 + j;
        if (((((R[k] * 15.99) | 0) << 8) | (((G[k] * 15.99) | 0) << 4) | ((B[k] * 15.99) | 0)) === top) {
          pr += R[k];
          pg += G[k];
          pb += B[k];
        }
      }
    }
    const hits = Math.max(1, counts[top]);
    this.page = [pr / hits, pg / hits, pb / hits];
    this.graphic += (FY.smoothstep(0.1, 0.28, counts[top] / Math.max(1, seen)) - this.graphic) * 0.5;
    if (this.graphic < 0.98) {                                  // photo-like: the light's 2%..98% range
      const lum = this.lum;
      let m = 0;
      for (let c = 0; c < n; c++) {
        for (const j of [0, 3, 6]) {
          const k = c * 8 + j;
          lum[m++] = 0.299 * R[k] + 0.587 * G[k] + 0.114 * B[k];
        }
      }
      const sorted = lum.slice(0, m).sort();
      const k = Math.floor(m / 50);
      const lo = sorted[k], hi = sorted[m - 1 - k];
      this.span = [lo, Math.max(hi, lo + 0.05)];
    }

    const d = [0], p8 = new Float32Array(8), d8 = new Float32Array(8), fine = this.fine;
    for (let c = 0; c < n; c++) {
      let total = 0, sq = 0;
      for (let j = 0; j < 8; j++) {
        const k = c * 8 + j;
        const p = this.cover(R[k], G[k], B[k], d);
        p8[j] = p;
        d8[j] = d[0];
        total += p;
        sq += p * p;
      }
      const mean = total / 8;
      let g = TONE[FY.clip((mean * this.grain[c] * 255) | 0, 0, 255)];
      if (sq / 8 - mean * mean > 0.03) {                        // a cell holding an outline: look closely
        const cx = c % cols, cy = (c / cols) | 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 4; x++) {
            const a = ((cy * 8 + y) * W + cx * 4 + x) * 4;
            fine[y * 4 + x] = this.cover(px[a] / 255, px[a + 1] / 255, px[a + 2] / 255, d);
          }
        }
        g = FY.match32(fine, 0.82);
      }
      glyph[c] = g;
      let wr = 0, wg = 0, wb = 0, ws = 0, pop = 0;
      for (let j = 0; j < 8; j++) {
        const w = p8[j] + 0.02, k = c * 8 + j;
        wr += R[k] * w;
        wg += G[k] * w;
        wb += B[k] * w;
        ws += w;
        if (d8[j] >= 0) pop += d8[j] * p8[j];
      }
      pop = d8[0] >= 0 ? this.graphic * FY.clip((pop / Math.max(total, 1e-3)) * 2, 0, 1) : 0;
      fg[c] = glow(wr / ws, wg / ws, wb / ws, pop);
    }
  }
};
