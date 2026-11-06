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
    this.bg = new Int32Array(w * h);                            // paper behind a cell (0 = none)
  }
  clear() {
    this.ch.fill(SPACE);
    this.fg.fill(0);
    this.bg.fill(0);
  }
  put(x, y, text, fg, bg) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    const chars = Array.from(text);
    const n = Math.min(chars.length, this.w - x);
    const at = y * this.w + x;
    for (let i = 0; i < n; i++) {
      this.ch[at + i] = chars[i].codePointAt(0);
      this.fg[at + i] = typeof fg === "number" ? fg : fg[i];
      if (bg !== undefined) this.bg[at + i] = bg;
    }
  }
  fill(x, y, w, bg) {
    if (y < 0 || y >= this.h) return;
    for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
      this.ch[y * this.w + i] = SPACE;
      this.bg[y * this.w + i] = bg;
    }
  }
  free(x, y) {
    const i = y * this.w + x;
    return x >= 0 && x < this.w && y >= 0 && y < this.h && this.ch[i] === SPACE && !this.bg[i];
  }
};

// ── drawing the screen onto a canvas ────────────────────────────────────────
// every glyph is drawn once, in white, into an atlas. each frame copies the glyphs
// cell by cell, then one pass tints them: a tiny picture with one pixel per cell,
// stretched over the whole canvas, keeps only where there is ink ("source-in").
const FONT = 'Consolas, "Cascadia Mono", Menlo, "SF Mono", "DejaVu Sans Mono", "Roboto Mono", ' +
  '"Noto Sans Mono", "Liberation Mono", "Courier New", monospace';
const AS_TEXT = new Set([0x2665, 0x266a, 0x266b, 0x2022]);   // never as emoji
const line = (h) => Math.max(1, Math.round(h));
const BLOCKS = {                                              // [x, y, w, h] inside a w x h cell
  0x2580: (w, h) => [0, 0, w, h / 2],                         // ▀
  0x2584: (w, h) => [0, h / 2, w, h / 2],                     // ▄
  0x2588: (w, h) => [0, 0, w, h],                             // █
  0x258c: (w, h) => [0, 0, w / 2, h],                         // ▌
  0x2590: (w, h) => [w / 2, 0, w / 2, h],                     // ▐
  0x2500: (w, h) => [0, Math.round(h / 2 - line(h * 0.06) / 2), w, line(h * 0.06)],   // ─
  0x2501: (w, h) => [0, Math.round(h / 2 - line(h * 0.13) / 2), w, line(h * 0.13)],   // ━
  0x2502: (w, h) => [Math.round(w / 2 - line(w * 0.12) / 2), 0, line(w * 0.12), h],   // │
  0x25a0: (w, h) => [w * 0.15, h * 0.32, w * 0.7, w * 0.7],    // ■
};

FY.Renderer = class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.atlas = document.createElement("canvas");
    this.actx = this.atlas.getContext("2d");
    this.tint = document.createElement("canvas");
    this.tctx = this.tint.getContext("2d");
    this.paper = document.createElement("canvas");
    this.pctx = this.paper.getContext("2d");
    this.cols = this.rows = this.cw = 0;
  }

  /** client (css px) coordinates -> [column, row] of the grid. */
  cellAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [Math.floor(((clientX - r.left) / r.width) * this.cols), Math.floor(((clientY - r.top) / r.height) * this.rows)];
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
    this.tint.width = this.paper.width = cols;
    this.tint.height = this.paper.height = rows;
    this.paint = this.tctx.createImageData(cols, rows);
    this.paperImg = this.pctx.createImageData(cols, rows);
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
    const block = BLOCKS[code];
    if (block) {                                                // blocks and rules: exact, so they join up
      a.fillStyle = "#fff";
      const [bx, by, bw, bh] = block(cw, chh);
      a.fillRect(x + bx, y + by, bw, bh);
      this.slots.set(code, s);
      return s;
    }
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
    // paper: cells with a background colour, slid in behind the glyphs
    const pp = this.paperImg.data, bg = scr.bg;
    let any = false;
    for (let i = 0; i < bg.length; i++) {
      const b = bg[i], o = i * 4;
      if (!b) {
        pp[o + 3] = 0;
        continue;
      }
      any = true;
      pp[o] = (b >> 16) & 255;
      pp[o + 1] = (b >> 8) & 255;
      pp[o + 2] = b & 255;
      pp[o + 3] = 255;
    }
    if (any) {
      this.pctx.putImageData(this.paperImg, 0, 0);
      ctx.globalCompositeOperation = "destination-over";
      ctx.drawImage(this.paper, 0, 0, cols, rows, 0, 0, W, H);
    }
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
      if (scr.ch[at] !== SPACE || scr.bg[at]) continue;
      scr.ch[at] = step === 6 ? 42 : step === 5 ? 43 : 46;      // * + .
      scr.fg[at] = this.colour[i * 7 + step];
      if (this.glint[i] && step === 6) cross.push(i);
    }
    for (const i of cross) {                                    // a little cross of light
      const x = this.x[i] + x0, y = this.y[i] + y0;
      for (const [dx, dy, c] of [[-1, 0, 45], [1, 0, 45], [0, -1, 124], [0, 1, 124]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= x0 && xx < x0 + w && yy >= y0 && yy < y0 + h && scr.free(xx, yy)) {
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

// ── colours and little text helpers the scenes share ────────────────────────
const rgb = (FY.rgb = (r, g, b) => (r << 16) | (g << 8) | b);
FY.C = {
  TEXT: rgb(206, 206, 214), KEYWORD: rgb(255, 95, 140), FUNC: rgb(255, 186, 112), STRING: rgb(150, 214, 160),
  NUMBER: rgb(186, 152, 255), COMMENT: rgb(104, 104, 118), OP: rgb(150, 150, 162), NAME: rgb(120, 196, 255),
  LINENO: rgb(72, 72, 84), HILITE: rgb(46, 10, 22), BAR: rgb(255, 70, 122), HUD: rgb(150, 150, 162),
  PINK: rgb(255, 92, 138), RULE: rgb(30, 30, 38), STATUS: rgb(196, 196, 204),
};
// the edit's colours: hot pink, rose, blush, a little mist, and a deep wine for things barely there
FY.HOT = [1, 64 / 255, 129 / 255];
FY.ROSE = [236 / 255, 92 / 255, 140 / 255];
FY.BLUSH = [1, 196 / 255, 214 / 255];
FY.MIST = [236 / 255, 220 / 255, 228 / 255];
FY.WINE = [110 / 255, 24 / 255, 60 / 255];
FY.CYAN = [90 / 255, 230 / 255, 255 / 255];
FY.inkOf = (c, k = 1) => FY.pack(c[0] * k, c[1] * k, c[2] * k);
FY.len = (s) => Array.from(s).length;
/** 'for you' -> 'f o r   y o u': small, airy letters. */
FY.spaced = (text) => text.split(" ").filter(Boolean).map((w) => Array.from(w).join(" ")).join("   ");
FY.TOUCH = matchMedia("(pointer: coarse)").matches;
FY.CROP = 0.97;                                   // trim a hair off the edit's edges, like art.py

// ── the code pane: types a python file out line by line ─────────────────────
const KEYWORDS = new Set(("False None True and as assert async await break class continue def del elif else except " +
  "finally for from global if import in is lambda nonlocal not or pass raise return try while with yield").split(" "));

/** colours for python source, token by token, the way art.py's highlighter does it. */
function highlight(lines, builtins) {
  const C = FY.C, paint = lines.map((l) => new Int32Array(l.length).fill(C.TEXT));
  const set = (r0, c0, r1, c1, colour) => {
    for (let r = r0; r <= r1; r++) paint[r].fill(colour, r === r0 ? c0 : 0, r === r1 ? c1 : paint[r].length);
  };
  let prev = "", r = 0, c = 0;
  while (r < lines.length) {
    const L = lines[r];
    if (c >= L.length) { r++; c = 0; continue; }
    const ch = L[c], rest = L.slice(c);
    if (ch === " " || ch === "\t") { c++; continue; }
    if (ch === "#") { set(r, c, r, L.length, C.COMMENT); r++; c = 0; continue; }
    const str = /^([rRbBuUfF]{0,2})("""|'''|"|')/.exec(rest);
    if (str && !/[A-Za-z0-9_]/.test(L[c - 1] || "")) {         // a string, maybe over several lines
      const q = str[2];
      let er = r, ec = c + str[0].length, done = false;
      while (er < lines.length && !done) {
        const E = lines[er];
        while (ec < E.length) {
          if (E[ec] === "\\") { ec += 2; continue; }
          if (E.startsWith(q, ec)) { ec += q.length; done = true; break; }
          ec++;
        }
        if (!done) {
          if (q.length === 1) { ec = E.length; done = true; } else { er++; ec = 0; }
        }
      }
      er = Math.min(er, lines.length - 1);
      set(r, c, er, Math.min(ec, lines[er].length), C.STRING);
      r = er;
      c = ec;
      continue;
    }
    const num = /^(0[xXoObB][0-9a-fA-F_]+|(\d[\d_]*\.?\d*|\.\d+)([eE][+-]?\d+)?j?)/.exec(rest);
    if (num && /[0-9.]/.test(ch) && !(ch === "." && !/\d/.test(L[c + 1] || ""))) {
      set(r, c, r, c + num[0].length, C.NUMBER);
      c += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) {
      const w = name[0];
      const colour = KEYWORDS.has(w) ? C.KEYWORD : prev === "def" || prev === "class" ? C.FUNC : builtins.has(w) ? C.NAME : null;
      if (colour !== null) set(r, c, r, c + w.length, colour);
      prev = w;
      c += w.length;
      continue;
    }
    const op = /^(\*\*=|\/\/=|>>=|<<=|\.\.\.|->|:=|[-+*/%@&|^<>=!]=|\*\*|\/\/|<<|>>|[-+*/%@&|^~<>=.,:;()[\]{}!])/.exec(rest);
    if (op) {
      set(r, c, r, c + op[0].length, C.OP);
      prev = op[0];
      c += op[0].length;
      continue;
    }
    c++;
  }
  return paint;
}

/** types a source file out, line by line, while the art plays (art.py's Code). */
FY.Code = class Code {
  constructor(src, cps, builtins) {
    this.lines = src.replace(/\r/g, "").split("\n");
    this.paint = highlight(this.lines, new Set(builtins));
    this.starts = [0];
    for (const l of this.lines) this.starts.push(this.starts[this.starts.length - 1] + l.length + 1);
    this.total = Math.max(1, this.starts[this.starts.length - 1]);
    const mark = Math.max(0, this.lines.findIndex((l) => l.startsWith("# ── the art")));
    this.begin = this.starts[mark];
    this.cps = cps;
  }

  draw(scr, x, y, w, h, t) {
    if (w < 14 || h < 1) return;
    const C = FY.C, pos = (this.begin + Math.trunc(t * this.cps)) % this.total;
    let lo = 0, hi = this.starts.length - 1;                     // the line holding pos
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    const line = lo, col = pos - this.starts[line];
    const top = line - Math.trunc(h * 0.62), cx = x + 7, room = w - 8;
    for (let r = 0; r < h; r++) {
      const n = top + r;
      if (n < 0 || n > line) continue;
      const here = n === line, row = y + r, bg = here ? C.HILITE : 0;
      const fade = Math.min(1, (r + 1) / 4);                    // older lines melt into the dark
      if (here) {
        scr.fill(x, row, w, bg);
        scr.put(x, row, "▌", C.BAR, bg);
      }
      scr.put(x + 1, row, String(n + 1).padStart(4), here ? C.BAR : FY.dim(C.LINENO, fade), bg);
      const text = this.lines[n].slice(0, here ? col : undefined).slice(0, room);
      if (text) scr.put(cx, row, text, Array.from(this.paint[n].subarray(0, text.length), (c) => FY.dim(c, fade)), here ? bg : undefined);
      if (here) scr.put(Math.min(cx + text.length, x + w - 1), row, " ", 0, C.BAR);   // the cursor
    }
  }
};

/** art on top and code below (tall windows), or side by side (wide ones). (art.py's Layout) */
FY.Layout = class Layout {
  constructor(W, H, aspect, code, cell) {
    const fit = (bw, bh) => {
      const vw = Math.max(1, Math.min(bw, Math.trunc(bh * aspect * cell)));
      return [vw, Math.max(1, Math.min(bh, Math.trunc(vw / (aspect * cell) + 0.5)))];
    };
    const options = [];
    if (code) {
      const hc = Math.max(7, Math.trunc(H * 0.36));
      if (H - hc - 2 >= 10) options.push([[0, 0, W, H - hc - 2], [0, H - hc - 2, W], [0, H - hc, W, hc]]);
      const wc = Math.min(Math.max(44, Math.trunc(W * 0.4)), W - 24);
      if (wc >= 30) {
        const wa = W - wc - 1;
        options.push([[0, 0, wa, H], [wa + 1, 0, wc], [wa + 1, 2, wc, H - 2]]);
      }
    }
    if (!options.length) options.push([[0, 0, W, H - 1], [0, H - 1, W], null]);
    const area = (o) => fit(o[0][2], Math.max(1, o[0][3] - 4)).reduce((a, b) => a * b);
    const best = options.reduce((a, b) => (area(b) > area(a) ? b : a));
    [this.art, this.status, this.code] = best;
    const [ax, ay, aw, ah] = this.art, [vw, vh] = fit(aw, Math.max(1, ah - 4));
    this.video = [ax + Math.floor((aw - vw) / 2), ay + 1 + Math.floor((Math.max(1, ah - 4) - vh) / 2), vw, vh];
  }
};

// ── pictures of words, and your @ ───────────────────────────────────────────
FY.picture = async function (id, url) {
  const img = new Image();
  await new Promise((done, fail) => {                           // (plain onload: decode() can hang on some phones)
    img.onload = done;
    img.onerror = () => fail(new Error(`couldn't load the ${id} picture`));
    img.src = url;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const a = new Float32Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4] / 255;
  return { id, w: c.width, h: c.height, a, sat: null };
};

/** box-filter a picture down to h x w (every output pixel is the mean of its patch). */
function areaResize(pic, h, w) {
  if (!pic.sat) {                                               // a summed-area table, made once
    const S = new Float64Array((pic.h + 1) * (pic.w + 1)), W1 = pic.w + 1;
    for (let y = 0; y < pic.h; y++) {
      let run = 0;
      for (let x = 0; x < pic.w; x++) {
        run += pic.a[y * pic.w + x];
        S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + run;
      }
    }
    pic.sat = S;
  }
  const S = pic.sat, W1 = pic.w + 1;
  const ys = Int32Array.from({ length: h + 1 }, (_, i) => Math.floor((pic.h * i) / h));
  const xs = Int32Array.from({ length: w + 1 }, (_, i) => Math.floor((pic.w * i) / w));
  const out = new Float32Array(h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const total = S[ys[y + 1] * W1 + xs[x + 1]] - S[ys[y] * W1 + xs[x + 1]] - S[ys[y + 1] * W1 + xs[x]] + S[ys[y] * W1 + xs[x]];
      out[y * w + x] = total / Math.max((ys[y + 1] - ys[y]) * (xs[x + 1] - xs[x]), 1);
    }
  }
  return out;
}

const words = new Map();
/** a word picture as glyphs: solid strokes get dense letters, their edges get matching shapes.
    solid: one letter for every fully inked cell (steadier, so small words stay readable). */
FY.wordArt = function (cols, pic, solid = null) {
  const key = `${pic.id}|${cols}|${solid}`;
  if (words.has(key)) return words.get(key);
  const rows = Math.max(2, Math.round((cols * pic.h) / pic.w / 2));   // cells are twice as tall as wide
  const img = areaResize(pic, rows * 8, cols * 4);
  const rng = FY.rng(9), glyph = new Uint8Array(rows * cols), cover = new Float32Array(rows * cols);
  const cell = new Float32Array(32), full = solid ? FY.CHARS.indexOf(solid) : -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0, s2 = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 4; x++) {
          const v = img[(r * 8 + y) * cols * 4 + c * 4 + x];
          cell[y * 4 + x] = v;
          s += v;
          s2 += v * v;
        }
      }
      const mean = s / 32, i = r * cols + c;
      let g = TONE[FY.clip((mean * rng.uniform(0.8, 1.0) * 255) | 0, 0, 255)];
      if (full >= 0 && mean > 0.85) g = full;
      if (Math.sqrt(Math.max(0, s2 / 32 - mean * mean)) > 0.2) g = FY.match32(cell, 0.82);
      glyph[i] = g;
      cover[i] = mean;
    }
  }
  const art = { glyph, cover, rows, cols };
  words.set(key, art);
  return art;
};

/** your @, drawn big when the edit reaches its closing card. at the edit's own size the
    name would be a smudge a few rows tall, so it gets the handwritten-word treatment and
    moves exactly as the card does: up from below, two flashes, a bounce, then it settles. */
FY.Signature = class Signature {
  constructor(pic, data) {
    this.pic = pic;
    this.name = data.name;
    this.start = data.start;                                    // when the card comes up
    this.track = data.track;                                    // [seconds, offset, flash]
    this.tall = pic.h / pic.w;
    const rng = FY.rng(21);                                     // glitter just above and below the name
    this.sparks = Array.from({ length: 8 }, () => [rng.uniform(-0.05, 1.05), 0.5 + rng.choice([-1, 1]) * rng.uniform(0.7, 1.4), rng.uniform(0, FY.TAU)]);
  }
  draw(scr, box, videoH, age) {
    const [bx, by, bw, bh] = box, { HOT, BLUSH } = FY;
    const { glyph, cover, rows, cols } = FY.wordArt(Math.max(12, Math.min(Math.trunc(bw * 0.92), Math.trunc((bh * 1.1) / this.tall))), this.pic, "@");
    let i = 0;
    while (i + 1 < this.track.length && this.track[i + 1][0] <= age) i++;
    const [, off, flash] = this.track[i];
    const x0 = bx + Math.floor((bw - cols) / 2);
    const y0 = by + Math.floor((bh - rows) / 2) + Math.round((off / FY.CROP) * videoH);
    const bright = Math.min(1, 0.55 + age / 0.2);
    const band = FY.mod((age - 1.0) * 0.4, 2.2) - 0.4;          // once it has settled, a slow shine
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const g = glyph[r * cols + c], x = x0 + c, y = y0 + r;
        if (!g || x < bx || x >= bx + bw || y < by || y >= by + bh) continue;
        const fx = c / Math.max(cols - 1, 1), fy = r / Math.max(rows - 1, 1);
        let col;
        if (flash) col = BLUSH.map((v) => v * 0.4 + 0.6);      // the card's flashes: white-hot
        else {
          const k = 0.62 + 0.38 * cover[r * cols + c];
          const shine = age > 1.0 ? 0.33 * Math.exp(-(((fx - band + 0.15 * fy) / 0.05) ** 2)) : 0;
          col = [0, 1, 2].map((q) => (HOT[q] * (1 - fx * 0.85) + BLUSH[q] * fx * 0.85) * k + shine);
        }
        scr.ch[y * scr.w + x] = FY.CODES[g];
        scr.fg[y * scr.w + x] = FY.pack(col[0] * bright, col[1] * bright, col[2] * bright);
      }
    }
    if (age > 0.9) {                                            // and a little glitter around it
      for (const [sx, sy, ph] of this.sparks) {
        const b = Math.max(0, Math.sin((age - 0.9) * 1.7 + ph)) ** 3;
        const x = Math.trunc(x0 + sx * cols), y = Math.trunc(y0 + sy * rows);
        if (b <= 0.12 || y < by || y >= by + bh || x < bx || x >= bx + bw || !scr.free(x, y)) continue;
        scr.ch[y * scr.w + x] = b > 0.75 ? 42 : b > 0.4 ? 43 : 0xb7;
        const k = 0.35 + 0.65 * b;
        scr.fg[y * scr.w + x] = FY.pack((BLUSH[0] * 0.6 + 0.4) * k, (BLUSH[1] * 0.6 + 0.4) * k, (BLUSH[2] * 0.6 + 0.4) * k);
      }
    }
  }
};

// ── sound and pictures from the page ────────────────────────────────────────
/** the current video frame, cropped a hair and scaled to w x h pixels (RGBA), or null. */
FY.Grab = class Grab {
  constructor() {
    this.c = document.createElement("canvas");
    this.x = this.c.getContext("2d", { willReadFrequently: true });
  }
  get(video, w, h) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    if (this.c.width !== w || this.c.height !== h) {
      this.c.width = w;
      this.c.height = h;
    }
    const sw = vw * FY.CROP, sh = vh * FY.CROP;
    this.x.imageSmoothingEnabled = true;
    this.x.imageSmoothingQuality = "high";
    this.x.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
    try {
      return this.x.getImageData(0, 0, w, h).data;
    } catch (e) {                                               // served from somewhere that forbids reading it
      return null;
    }
  }
};

/** the edit, with its song: a <video> the canvas redraws. phones only let sound start from a
    tap, so the first tap wakes it; if sound is still refused it plays silently and says so. */
FY.VideoSong = class VideoSong {
  constructor(v, mute) {
    this.v = v;
    this.mute = mute;
    this.failed = !v || !v.canPlayType("video/mp4");
    this.blocked = false;
    this.woken = false;
    this.aspect = 1;
    this.length = 41.75;
    if (this.failed) return;
    v.muted = mute;
    v.addEventListener("loadedmetadata", () => {
      if (v.videoWidth) this.aspect = v.videoWidth / v.videoHeight;
      if (isFinite(v.duration)) this.length = v.duration;
    });
    v.addEventListener("error", () => { this.failed = true; });
  }
  wake() {                                                      // (inside a tap or key press, once)
    if (this.failed || this.woken) return;
    this.woken = true;
    const p = this.v.play();
    if (p && p.catch) p.catch(() => {});
    this.v.pause();
  }
  start() {
    if (this.failed) return;
    const v = this.v;
    v.currentTime = 0;
    v.muted = this.mute;
    const p = v.play();
    if (p && p.then) {
      p.then(() => { this.blocked = false; }).catch(() => {
        if (this.mute) return;
        this.blocked = true;                                    // no sound allowed yet: play silently,
        v.muted = true;                                         // and ask for a tap
        v.play().catch(() => {});
      });
    }
  }
  stop() {
    if (!this.failed) this.v.pause();
  }
  unmute() {
    const v = this.v;
    v.muted = false;
    this.blocked = false;
    v.play().catch(() => {});
  }
  time() { return this.failed ? 0 : this.v.currentTime; }
  ready() { return !this.failed && this.v.readyState >= 2; }
  over() {
    const v = this.v;
    return v.ended || (isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.04);
  }
};

/** a piece of music that loops without a seam (web audio plays the exact loop, sample for sample). */
FY.LoopSong = class LoopSong {
  constructor(url, length, mute) {
    this.length = length;
    this.buffer = this.src = null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (mute || !AC) return;
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";   // iphones: play on silent mode too
    } catch (e) { /* older safari */ }
    this.ctx = new AC();
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
      .then((data) => new Promise((done, fail) => this.ctx.decodeAudioData(data, done, fail)))
      .then((buffer) => {
        const ch = buffer.getChannelData(0);                    // skip any silent priming the decoder kept
        let first = 0;
        while (first < Math.min(ch.length, buffer.sampleRate / 5) && Math.abs(ch[first]) < 1e-4) first++;
        this.offset = first / buffer.sampleRate;
        this.buffer = buffer;
      })
      .catch(() => {
        this.buffer = null;
        this.failed = true;
      });
  }
  get ready() { return !!this.buffer; }
  get available() { return !!this.ctx && !this.failed; }
  wake() {                                                      // (inside a tap or key press)
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }
  start() {
    this.stop();
    if (!this.buffer) return false;
    const ctx = this.ctx, src = ctx.createBufferSource(), gain = ctx.createGain(), now = ctx.currentTime;
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = this.offset;
    src.loopEnd = Math.min(this.buffer.duration, this.offset + this.length);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.35);             // a breath of a fade in
    src.connect(gain).connect(ctx.destination);
    src.start(now, this.offset);
    this.src = src;
    this.gain = gain;
    return true;
  }
  stop() {
    if (!this.src) return;
    const ctx = this.ctx, now = ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0, now + 0.25);
    this.src.stop(now + 0.26);
    this.src = null;
  }
};
