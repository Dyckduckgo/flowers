/* gift.js - i grew some flowers for you. a web port of for_you.py from terminal-art:
   a little card, and when it's opened a garden grows under the stars and turns,
   slowly, while the edit and its song play beside it. */
"use strict";
(function () {
  const { TAU, clip, mod, pack, dim, CHARS, CODES, TONE, SPACE } = FY;
  const FPS = 30, SPIN = 0.12, CELL = 2.0, CROP = 0.97;

  // the edit's colours: hot pink, rose, blush, a little mist, and a deep wine for things barely there
  const HOT = [1, 64 / 255, 129 / 255];
  const ROSE = [236 / 255, 92 / 255, 140 / 255];
  const BLUSH = [1, 196 / 255, 214 / 255];
  const MIST = [236 / 255, 220 / 255, 228 / 255];
  const WINE = [110 / 255, 24 / 255, 60 / 255];
  const CYAN = [90 / 255, 230 / 255, 255 / 255];

  const query = new URLSearchParams(location.search);
  const MUTE = query.has("mute");
  const AUTOSTART = query.has("autostart") ? parseFloat(query.get("autostart")) || 6 : null;
  const TOUCH = matchMedia("(pointer: coarse)").matches;
  const PICS = {};

  const inkOf = (c, k = 1) => pack(c[0] * k, c[1] * k, c[2] * k);
  const len = (s) => Array.from(s).length;
  /** 'for you' -> 'f o r   y o u': small, airy letters. */
  const spaced = (text) => text.split(" ").filter(Boolean).map((w) => Array.from(w).join(" ")).join("   ");
  /** two quick beats, then a rest. */
  const heartbeat = (t) => {
    const p = mod(t, 1.15);
    return Math.exp(-((p / 0.07) ** 2)) + 0.65 * Math.exp(-(((p - 0.22) / 0.08) ** 2));
  };
  const at = (scr, x, y) => y * scr.w + x;
  const inside = (scr, x, y) => x >= 0 && x < scr.w && y >= 0 && y < scr.h;

  // ── word pictures ───────────────────────────────────────────────────────────
  async function picture(id, url) {
    const img = new Image();
    await new Promise((done, fail) => {                       // (plain onload: decode() can hang on some phones)
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
  }

  /** box-filter a picture down to h x w (every output pixel is the mean of its patch). */
  function areaResize(pic, h, w) {
    if (!pic.sat) {                                   // a summed-area table, made once
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
  function wordArt(cols, pic, solid = null) {
    const key = `${pic.id}|${cols}|${solid}`;
    if (words.has(key)) return words.get(key);
    const rows = Math.max(2, Math.round((cols * pic.h) / pic.w / 2));   // cells are twice as tall as wide
    const img = areaResize(pic, rows * 8, cols * 4);
    const rng = FY.rng(9), glyph = new Uint8Array(rows * cols), cover = new Float32Array(rows * cols);
    const cell = new Float32Array(32), full = solid ? CHARS.indexOf(solid) : -1;
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
        let g = TONE[clip((mean * rng.uniform(0.8, 1.0) * 255) | 0, 0, 255)];
        if (full >= 0 && mean > 0.85) g = full;
        if (Math.sqrt(Math.max(0, s2 / 32 - mean * mean)) > 0.2) g = FY.match32(cell, 0.82);
        glyph[i] = g;
        cover[i] = mean;
      }
    }
    const art = { glyph, cover, rows, cols };
    words.set(key, art);
    return art;
  }

  // ── the card ───────────────────────────────────────────────────────────────
  /** i grew some / flowers / for you, laid out inside one box of the screen. */
  class Poster {
    constructor(x, y, w, h, prompt) {
      const cols = Math.trunc(Math.min(w * 0.66, Math.max(0, h - 8) * 4.0));
      this.art = cols >= 18 ? wordArt(cols, PICS.flowers) : null;
      const rows = this.art ? this.art.rows : 1;
      const top = y + Math.max(0, Math.floor((h - (rows + 7)) / 2));
      this.cols = this.art ? cols : len(spaced("flowers"));
      this.rows = rows;
      this.wx = x + Math.floor((w - this.cols) / 2);
      this.wy = top + 2;
      this.line1 = spaced("i grew some");
      this.line2 = spaced("for you");
      this.at1 = [this.wx + Math.trunc(this.cols * 0.04), top];
      this.at2 = [this.wx + Math.trunc(this.cols * 0.96) - this.line2.length - 3, top + 2 + rows + 1];
      this.prompt = `·   ${spaced(prompt)}   ·`;
      this.atp = [x + Math.floor((w - len(this.prompt)) / 2), Math.min(y + h - 1, top + rows + 6)];
      const rng = FY.rng(12);
      this.sparks = Array.from({ length: 9 }, () => [
        rng.uniform(this.wx - 5, this.wx + this.cols + 5), rng.uniform(top - 1, top + rows + 4), rng.uniform(0, TAU)]);
    }

    /** t: seconds since the card began. shake > 0 glitches it, like the edit's FROM YOU. */
    draw(scr, t, shake = 0) {
      const jolt = () => (shake > 0 && Math.random() < shake ? Math.floor(Math.random() * 5) - 2 : 0);
      let [x, y] = this.at1;
      let n = Math.trunc(clip((t - 0.8) / 1.0, 0, 1) * this.line1.length);
      if (n) scr.put(x + jolt(), y, this.line1.slice(0, n), inkOf(MIST, 0.85));
      if (this.art) this.word(scr, t, clip((t - 1.6) / 2.0, 0, 1), shake);
      else if (t > 1.6) scr.put(this.wx + jolt(), this.wy, spaced("flowers").slice(0, Math.trunc((t - 1.6) / 0.08)), inkOf(HOT));
      [x, y] = this.at2;
      n = Math.trunc(clip((t - 3.5) / 0.8, 0, 1) * this.line2.length);
      if (n) scr.put(x + jolt(), y, this.line2.slice(0, n), inkOf(MIST, 0.85));
      if (t > 4.3) {                                              // the heart, beating
        const beat = heartbeat(t - 4.3), k = 0.65 + 0.35 * beat;
        scr.put(x + this.line2.length + 3 + jolt(), y, "♥", pack(HOT[0] * k + 0.25 * beat, HOT[1] * k + 0.25 * beat, HOT[2] * k + 0.25 * beat));
      }
      if (t > 2.0) this.sparkles(scr, t);
      if (t > 4.8 && shake === 0) {                               // and a soft nudge to begin
        const glow = Math.min(1, (t - 4.8) / 0.8) * (0.6 + 0.28 * Math.sin((t - 4.8) * 2.4));
        scr.put(this.atp[0], this.atp[1], this.prompt, inkOf(BLUSH, glow));
      }
    }

    word(scr, t, sweep, shake) {
      const { glyph, cover, rows, cols } = this.art;
      const shift = new Int32Array(rows);
      if (shake > 0) {                                            // glitch: torn rows, split colour
        for (let r = 0; r < rows; r++) if (Math.random() < shake * 0.6) shift[r] = Math.floor(Math.random() * 9) - 4;
        for (const [dx, tint] of [[-1, CYAN], [1, HOT]]) {
          const ghost = inkOf(tint, 0.75);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const g = glyph[r * cols + c];
              if (!g || c / Math.max(cols - 1, 1) > sweep) continue;
              this.cell(scr, r, c + shift[r] + dx, g, ghost);
            }
          }
        }
      }
      const band = mod((t - 4.0) * 0.32, 1.8) - 0.4;              // a slow shine passing over
      for (let r = 0; r < rows; r++) {
        const fy = r / Math.max(rows - 1, 1);
        for (let c = 0; c < cols; c++) {
          const g = glyph[r * cols + c], fx = c / Math.max(cols - 1, 1);
          if (!g || fx > sweep) continue;
          const mix = clip(fx * 0.85 + fy * 0.15, 0, 1), k = 0.62 + 0.38 * cover[r * cols + c];
          const pen = sweep < 1 ? Math.exp(-(((fx - sweep) / 0.025) ** 2)) : 0;   // glow where it's writing
          const shine = t > 4.0 ? Math.exp(-(((fx - band + 0.15 * fy) / 0.05) ** 2)) : 0;
          const lift = (pen + 0.55 * shine) * 0.6;
          this.cell(scr, r, c + shift[r], g, pack(
            (HOT[0] * (1 - mix) + BLUSH[0] * mix) * k + lift,
            (HOT[1] * (1 - mix) + BLUSH[1] * mix) * k + lift,
            (HOT[2] * (1 - mix) + BLUSH[2] * mix) * k + lift));
        }
      }
      if (sweep < 1) {                                            // the pen: a spark at the nib
        const front = Math.trunc(sweep * (cols - 1));
        for (let r = 0; r < rows; r++) {
          if (glyph[r * cols + front] || (front > 0 && glyph[r * cols + front - 1])) {
            this.cell(scr, r, front, CHARS.indexOf("*"), pack(1, 1, 1));
            break;
          }
        }
      }
    }

    cell(scr, r, c, g, colour) {
      const x = this.wx + c, y = this.wy + r;
      if (!inside(scr, x, y)) return;
      scr.ch[at(scr, x, y)] = CODES[g];
      scr.fg[at(scr, x, y)] = colour;
    }

    sparkles(scr, t) {
      for (const [sx, sy, ph] of this.sparks) {
        const b = Math.max(0, Math.sin(t * 1.6 + ph)) ** 3;
        const x = Math.trunc(sx), y = Math.trunc(sy);
        if (b < 0.12 || !scr.free(x, y)) continue;
        scr.ch[at(scr, x, y)] = b > 0.75 ? 42 : b > 0.4 ? 43 : 0xb7;
        scr.fg[at(scr, x, y)] = pack((BLUSH[0] * 0.6 + 0.4) * (0.35 + 0.65 * b), (BLUSH[1] * 0.6 + 0.4) * (0.35 + 0.65 * b), (BLUSH[2] * 0.6 + 0.4) * (0.35 + 0.65 * b));
        if (b > 0.85) {                                           // a little cross of light
          for (const [dx, dy, c] of [[-1, 0, 45], [1, 0, 45], [0, -1, 124], [0, 1, 124]]) {
            if (scr.free(x + dx, y + dy)) {
              scr.ch[at(scr, x + dx, y + dy)] = c;
              scr.fg[at(scr, x + dx, y + dy)] = inkOf(BLUSH, 0.4 * b);
            }
          }
        }
      }
    }
  }

  /** pink petals drifting down through the dark. */
  class FallingPetals {
    constructor(w, h) {
      const rng = (this.rng = FY.rng(4));
      const n = Math.max(10, Math.floor((w * h) / 130));
      this.w = w;
      this.h = h;
      this.list = Array.from({ length: n }, () => ({
        x: rng.uniform(0, w), y: rng.uniform(-h, h), fall: rng.uniform(1.2, 2.8), drift: rng.uniform(-1.2, 1.2),
        phase: rng.uniform(0, TAU), tint: [HOT, ROSE, BLUSH][rng.int(0, 3)],
      }));
      this.look = Array.from("',`.,'`", (c) => c.codePointAt(0));
    }
    draw(scr, t, dt, strength = 1) {
      for (const p of this.list) {
        p.y += p.fall * dt;
        p.x += (p.drift + 1.6 * Math.sin(t * 1.1 + p.phase)) * dt;
        if (p.y > this.h) {
          p.y -= this.h + this.rng.uniform(2, 8);
          p.x = this.rng.uniform(0, this.w);
        }
        const x = mod(Math.trunc(p.x), this.w), y = Math.trunc(p.y);
        if (y < 0 || y >= this.h || !scr.free(x, y)) continue;
        const turn = Math.trunc((mod(t * 2.2 + p.phase, TAU) / TAU) * this.look.length);
        scr.ch[at(scr, x, y)] = this.look[Math.min(turn, this.look.length - 1)];
        scr.fg[at(scr, x, y)] = inkOf(p.tint, 0.75 * strength);
      }
    }
  }

  /** slow ripples spreading from the middle, like the rings in the edit - barely there. */
  class Rings {
    constructor(w, h, cell) {
      this.d = new Float32Array(w * h);
      let reach = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x + 0.5 - w / 2, (y + 0.5 - h / 2) * cell);
          this.d[y * w + x] = d;
          reach = Math.max(reach, d);
        }
      }
      this.reach = reach;
    }
    draw(scr, t, strength = 1) {
      for (let i = 0; i < this.d.length; i++) {
        const d = this.d[i];
        const edge = clip((d / this.reach - 0.2) / 0.25, 0, 1);  // keep the middle clear for the words
        if (edge <= 0.05 || mod(d - t * 2.2, 10.0) >= 0.9 || scr.ch[i] !== SPACE) continue;
        scr.ch[i] = 0xb7;
        scr.fg[i] = inkOf(WINE, 0.45 + 0.9 * clip(1 - d / this.reach, 0, 1) * edge * strength);
      }
    }
  }

  /** the card letting go: every letter becomes a bit of glitter flying outward. */
  class Dust {
    constructor(scr, box, cell) {
      const [x, y, w, h] = box, rng = FY.rng(8);
      this.list = [];
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = at(scr, xx, yy);
          if (scr.ch[i] === SPACE) continue;
          const dx = xx - (x + w / 2), dy = (yy - (y + h / 2)) * cell, dist = Math.hypot(dx, dy) + 1e-3;
          const speed = rng.uniform(10, 34);
          this.list.push({
            ch: scr.ch[i], fg: scr.fg[i], x: xx, y: yy,
            vx: (dx / dist) * speed + rng.normal(0, 4), vy: ((dy / dist) * speed) / cell - rng.uniform(1, 5),
            life: rng.uniform(0.45, 0.95),
          });
        }
      }
    }
    draw(scr, age) {
      for (const d of this.list) {
        const f = clip(1 - age / d.life, 0, 1);
        const x = Math.trunc(d.x + d.vx * age), y = Math.trunc(d.y + d.vy * age);
        if (f <= 0 || !inside(scr, x, y)) continue;
        scr.ch[at(scr, x, y)] = f > 0.6 ? d.ch : f > 0.3 ? 42 : 46;
        scr.fg[at(scr, x, y)] = FY.fade(d.fg, f);
      }
    }
  }

  /** your @, drawn big when the edit reaches its closing card. at the edit's own size the
      name would be a smudge a few rows tall, so it gets the handwritten-word treatment and
      moves exactly as the card does: up from below, two flashes, a bounce, then it settles. */
  class Signature {
    constructor(pic, data) {
      this.pic = pic;
      this.start = data.start;                                  // when the card comes up
      this.track = data.track;                                  // [seconds, offset, flash]
      this.tall = pic.h / pic.w;
      const rng = FY.rng(21);                                   // glitter just above and below the name
      this.sparks = Array.from({ length: 8 }, () => [rng.uniform(-0.05, 1.05), 0.5 + rng.choice([-1, 1]) * rng.uniform(0.7, 1.4), rng.uniform(0, TAU)]);
    }
    draw(scr, box, videoH, age) {
      const [bx, by, bw, bh] = box;
      const { glyph, cover, rows, cols } = wordArt(Math.max(12, Math.min(Math.trunc(bw * 0.92), Math.trunc((bh * 1.1) / this.tall))), this.pic, "@");
      let i = 0;
      while (i + 1 < this.track.length && this.track[i + 1][0] <= age) i++;
      const [, off, flash] = this.track[i];
      const x0 = bx + Math.floor((bw - cols) / 2);
      const y0 = by + Math.floor((bh - rows) / 2) + Math.round((off / CROP) * videoH);
      const bright = Math.min(1, 0.55 + age / 0.2);
      const band = mod((age - 1.0) * 0.4, 2.2) - 0.4;            // once it has settled, a slow shine
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const g = glyph[r * cols + c];
          const x = x0 + c, y = y0 + r;
          if (!g || x < bx || x >= bx + bw || y < by || y >= by + bh) continue;
          const fx = c / Math.max(cols - 1, 1), fy = r / Math.max(rows - 1, 1);
          let rgb;
          if (flash) rgb = BLUSH.map((v) => v * 0.4 + 0.6);      // the card's flashes: white-hot
          else {
            const k = 0.62 + 0.38 * cover[r * cols + c];
            const shine = age > 1.0 ? 0.33 * Math.exp(-(((fx - band + 0.15 * fy) / 0.05) ** 2)) : 0;
            rgb = [0, 1, 2].map((q) => (HOT[q] * (1 - fx * 0.85) + BLUSH[q] * fx * 0.85) * k + shine);
          }
          scr.ch[at(scr, x, y)] = CODES[g];
          scr.fg[at(scr, x, y)] = pack(rgb[0] * bright, rgb[1] * bright, rgb[2] * bright);
        }
      }
      if (age > 0.9) {                                          // and a little glitter around it
        for (const [sx, sy, ph] of this.sparks) {
          const b = Math.max(0, Math.sin((age - 0.9) * 1.7 + ph)) ** 3;
          const x = Math.trunc(x0 + sx * cols), y = Math.trunc(y0 + sy * rows);
          if (b <= 0.12 || y < by || y >= by + bh || x < bx || x >= bx + bw || !scr.free(x, y)) continue;
          scr.ch[at(scr, x, y)] = b > 0.75 ? 42 : b > 0.4 ? 43 : 0xb7;
          const k = 0.35 + 0.65 * b;
          scr.fg[at(scr, x, y)] = pack((BLUSH[0] * 0.6 + 0.4) * k, (BLUSH[1] * 0.6 + 0.4) * k, (BLUSH[2] * 0.6 + 0.4) * k);
        }
      }
    }
  }

  // ── the show: garden on one side, the edit on the other ────────────────────
  class Stage {
    constructor(W, H, aspect, sign) {
      this.W = W;
      this.H = H;
      this.scr = new FY.Screen(W, H);
      const body = H - 2;                                       // row 0: title, last row: the song
      if (aspect == null) {
        this.garden = [0, 1, W, body];
        this.edit = null;
      } else if (W >= body * CELL * 1.8) {
        const half = Math.floor(W / 2);
        this.garden = [0, 1, half, body];
        this.edit = [half, 1, W - half, body];
      } else {
        const half = Math.floor(body / 2);
        this.garden = [0, 1, W, half];
        this.edit = [0, 1 + half, W, body - half];
      }
      this.view = new FY.View(...this.garden, CELL, [1, 1]);
      this.video = null;
      if (this.edit) {
        const [ex, ey, ew, eh] = this.edit;
        const vh = Math.max(2, Math.min(eh - 1, Math.trunc((ew - 2) / (aspect * CELL))));
        const vw = Math.max(2, Math.min(ew - 2, Math.trunc(vh * aspect * CELL)));
        this.video = [ex + Math.floor((ew - vw) / 2), ey + Math.floor((eh - vh) / 2), vw, vh];
        this.glyph = new Uint8Array(vw * vh);
        this.fg = new Int32Array(vw * vh);
      }
      this.card = new Poster(...(this.edit || this.garden), TOUCH ? "tap again" : "r again");
      this.sign = this.video ? sign : null;
    }

    compose(garden, sky, stars, ink, frame, t, songT, spin, length, ended, petals, dt) {
      const scr = this.scr, [gx, gy, gw, gh] = this.garden;
      scr.clear();
      const [pts, tips] = garden.points(t, this.view.res);
      const depth = this.view.draw(scr, pts, t, spin, garden.phases);
      FY.moon(scr, gx, gy, gw, gh, CELL);
      stars.draw(scr, 0, 0, this.W, this.H, t);
      if (petals) petals.draw(scr, t, dt, 0.6);                // the card's petals keep falling
      if (frame && this.sign && songT >= this.sign.start) {
        this.sign.draw(scr, this.edit, this.video[3], songT - this.sign.start);   // the edit signs off: your @
      } else if (frame && this.video) {                         // the edit, as glyph art
        const [vx, vy, vw, vh] = this.video, k = Math.min(1, t / 0.8);
        ink.run(frame, vw, vh, this.glyph, this.fg);
        for (let r = 0; r < vh; r++) {
          for (let c = 0; c < vw; c++) {
            const i = r * vw + c, a = (vy + r) * this.W + vx + c;
            scr.ch[a] = CODES[this.glyph[i]];
            scr.fg[a] = dim(this.fg[i], k);
          }
        }
      } else if (ended !== null) {                              // the song is over: the card again
        this.card.draw(scr, ended);
      }
      sky.draw(scr, this.view, depth, t, spin);
      this.title(scr, t);
      this.song(scr, songT, length, ended);
      return tips;
    }

    title(scr, t) {
      let text = "i grew some flowers for you";
      if (len(spaced(text)) + 8 < this.W) text = `·   ${spaced(text)}   ·`;
      const chars = Array.from(text), n = Math.trunc(clip(t / 1.6, 0, 1) * chars.length);
      scr.put(Math.floor((this.W - chars.length) / 2), 0, chars.slice(0, n).join(""), inkOf(ROSE, 0.85 + 0.15 * Math.sin(t * 0.9)));
    }

    song(scr, t, length, ended) {
      if (!length) return;
      const clock = (s) => {
        s = Math.max(0, Math.trunc(s));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      const played = Math.min(t, length);
      const left = `♪  ${clock(played)}  `, right = `  ${clock(length)}`;
      const bar = Math.max(10, Math.min(56, this.W - left.length - right.length - 8));
      const x = Math.floor((this.W - left.length - bar - right.length) / 2);
      const done = Math.round((bar * played) / length), y = this.H - 1;
      scr.put(x, y, left, inkOf(ROSE, 0.9));
      scr.put(x + left.length, y, "━".repeat(done), inkOf(HOT, 0.9));
      scr.put(x + left.length + done, y, "─".repeat(bar - done), inkOf(WINE, 1.2));
      if (done < bar) scr.put(x + left.length + done, y, "•", inkOf(BLUSH));
      scr.put(x + left.length + bar, y, right, inkOf(MIST, 0.55));
    }

    /** a quiet line of help, bottom right (below the edit, clear of the garden's middle). */
    note(text, k) {
      const scr = this.scr, chars = Array.from(` ${text} `), y = this.H - 2, x = this.W - chars.length - 1;
      chars.forEach((c, i) => {
        if (!inside(scr, x + i, y)) return;
        scr.ch[at(scr, x + i, y)] = c.codePointAt(0);
        scr.fg[at(scr, x + i, y)] = inkOf(MIST, k);
      });
    }
  }

  // ── the song: the edit's own video, played by the browser ──────────────────
  class Song {
    constructor(v) {
      this.v = v;
      this.failed = !v || !v.canPlayType("video/mp4");
      this.blocked = false;
      this.aspect = 1;
      this.length = 41.75;
      if (this.failed) return;
      v.muted = MUTE;
      v.addEventListener("loadedmetadata", () => {
        if (v.videoWidth) this.aspect = v.videoWidth / v.videoHeight;
        if (isFinite(v.duration)) this.length = v.duration;
      });
      v.addEventListener("error", () => { this.failed = true; });
    }
    /** inside the tap or key press: phones only let sound start from one, so wake the player now. */
    unlock() {
      if (this.failed) return;
      const p = this.v.play();
      if (p && p.catch) p.catch(() => {});
      this.v.pause();
    }
    start() {
      if (this.failed) return;
      const v = this.v;
      v.currentTime = 0;
      v.muted = MUTE;
      const p = v.play();
      if (p && p.then) {
        p.then(() => { this.blocked = false; }).catch(() => {
          if (MUTE) return;
          this.blocked = true;                                    // no sound allowed yet: play silently,
          v.muted = true;                                         // and ask for a tap
          v.play().catch(() => {});
        });
      }
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
  }

  /** the current video frame, cropped a hair and scaled to cols*4 x rows*8 pixels. */
  class Grab {
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
      const sw = vw * CROP, sh = vh * CROP;
      this.x.imageSmoothingEnabled = true;
      this.x.imageSmoothingQuality = "high";
      this.x.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
      try {
        return this.x.getImageData(0, 0, w, h).data;
      } catch (e) {                                             // served from somewhere that forbids reading it
        return null;
      }
    }
  }

  // ── putting it together ────────────────────────────────────────────────────
  async function main() {
    const canvas = document.getElementById("screen");
    const video = document.getElementById("song");
    const D = window.FY_DATA;
    [PICS.flowers, PICS.signature] = await Promise.all([picture("flowers", D.flowers), picture("signature", D.signature)]);
    const sign = new Signature(PICS.signature, D);
    const song = new Song(video), grab = new Grab(), R = new FY.Renderer(canvas), stars = new FY.Stars();
    const clock = () => performance.now() / 1000;
    let W = 0, H = 0, scr, poster, petals, rings, stage, hadVideo = false;
    let scene = "card", start = clock(), last = start, left = 0, dust = null;
    let show = 0, garden = null, sky = null, ink = null, spin = 0, speed = 0, chosen = SPIN, ended = null;

    function rebuild() {                                        // (re)build everything for this window
      W = R.cols;
      H = R.rows;
      scr = new FY.Screen(W, H);
      poster = new Poster(0, 0, W, H, TOUCH ? "tap to open" : "press enter");
      petals = new FallingPetals(W, H);
      rings = new Rings(W, H, CELL);
      hadVideo = !song.failed;
      stage = new Stage(W, H, hadVideo ? song.aspect : null, sign);
    }
    R.fit();
    rebuild();

    function begin() {
      if (scene !== "card") return;
      song.unlock();
      scene = "leaving";
      left = clock();
      scr.clear();
      poster.draw(scr, 99);
      dust = new Dust(scr, [0, 0, W, H], CELL);
      if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(() => {});
    }
    function again() {                                          // from the very beginning
      if (scene !== "show") return;
      song.start();
      show = clock();
      garden = new FY.Garden();
      sky = new FY.Sky();
      ended = null;
      spin = speed = 0;
    }
    const faster = () => { chosen = Math.min(1.5, Math.round((chosen + 0.04) * 100) / 100); };
    const slower = () => { chosen = Math.max(0, Math.round((chosen - 0.04) * 100) / 100); };
    function tap() {
      if (scene === "card") begin();
      else if (scene === "show" && song.blocked) song.unmute();
      else if (scene === "show" && ended !== null) again();
    }

    addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "Enter") tap();
      else if (k === "r" || k === "R") again();
      else if (k === "ArrowUp" || k === "+" || k === "=") faster();
      else if (k === "ArrowDown" || k === "-" || k === "_") slower();
      else return;
      e.preventDefault();
    });
    let drag = null;                                            // swipe up / down: faster / slower
    addEventListener("pointerdown", (e) => { drag = { y: e.clientY, step: 0, moved: 0 }; });
    addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      drag.y = e.clientY;
      drag.moved += Math.abs(dy);
      drag.step += dy;
      for (; drag.step <= -28; drag.step += 28) faster();
      for (; drag.step >= 28; drag.step -= 28) slower();
    });
    addEventListener("pointerup", () => { setTimeout(() => { drag = null; }, 0); });
    addEventListener("pointercancel", () => { drag = null; });
    // taps: on touch screens a touchend (iPhones send no click for a plain canvas, and a touchend
    // is what lets sound start); with a mouse, a click
    let touchY = 0, touchMoved = 0, lastTouch = -1e9;
    addEventListener("touchstart", (e) => {
      touchY = e.touches[0].clientY;
      touchMoved = 0;
    }, { passive: true });
    addEventListener("touchmove", (e) => {
      touchMoved += Math.abs(e.touches[0].clientY - touchY);
      touchY = e.touches[0].clientY;
    }, { passive: true });
    addEventListener("touchend", (e) => {
      lastTouch = performance.now();
      if (touchMoved < 12) {
        e.preventDefault();                                   // (no second, mouse-style click)
        tap();
      }
    }, { passive: false });
    addEventListener("click", () => {
      if (performance.now() - lastTouch < 800) return;        // already handled as a touch
      if (!drag || drag.moved < 12) tap();
    });
    let wheel = 0;
    addEventListener("wheel", (e) => {
      wheel += e.deltaY;
      for (; wheel <= -100; wheel += 100) faster();
      for (; wheel >= 100; wheel -= 100) slower();
    }, { passive: true });

    function frame(ms) {
      requestAnimationFrame(frame);
      const now = ms / 1000;
      if (now - last < 1 / FPS - 0.004) return;
      const dt = Math.min(now - last, 0.1);
      last = now;
      const work = performance.now();
      if (R.fit() || hadVideo !== !song.failed) rebuild();

      if (scene === "card") {
        if (AUTOSTART !== null && now - start > AUTOSTART) begin();
        const t = now - start;
        scr.clear();
        rings.draw(scr, t);
        stars.draw(scr, 0, 0, W, H, t);
        petals.draw(scr, t, dt);
        poster.draw(scr, t);
        R.draw(scr);
      } else if (scene === "leaving") {                         // a glitch, then glitter
        const age = now - left, t = now - start;
        scr.clear();
        stars.draw(scr, 0, 0, W, H, t);
        petals.draw(scr, t, dt, Math.max(0, 1 - age));
        if (age < 0.45) {
          rings.draw(scr, t, 1 - age / 0.45);
          poster.draw(scr, 99, 0.5 + age);
        } else dust.draw(scr, age - 0.45);
        R.draw(scr);
        if (age > 1.45) {
          scene = "show";
          show = now;
          garden = new FY.Garden();
          sky = new FY.Sky();
          ink = new FY.Ink();
          spin = speed = 0;
          chosen = SPIN;
          ended = null;
          song.start();
        }
      } else {                                                  // the show
        const t = now - show, songT = song.time();
        let shot = null;
        if (stage.video && ended === null) {
          const signing = stage.sign && songT >= stage.sign.start;   // (the name needs no picture)
          if (song.over()) ended = t;
          else if (song.ready()) shot = signing ? true : grab.get(video, stage.video[2] * 4, stage.video[3] * 8);
        }
        const target = t > garden.done + 0.4 ? chosen : 0;
        speed += (target - speed) * Math.min(1, dt * 1.5);
        spin += speed * TAU * dt;
        const tips = stage.compose(garden, sky, stars, ink, shot, t, songT, spin, hadVideo ? song.length : 0,
          ended === null ? null : t - ended, petals, dt);
        sky.sparkle(tips, dt);
        if (song.blocked) {
          stage.note(TOUCH ? "tap for sound ♪" : "press enter for sound ♪", 0.55 + 0.35 * Math.sin(now * 3));
        } else {
          const since = t - garden.done - 0.4;                  // once it starts to turn: how to steer it
          if (since > 0 && since < 6) {
            stage.note(TOUCH ? "swipe ↑ ↓ to spin" : "↑ ↓  spin faster / slower", 0.6 * Math.min(1, since, 6 - since));
          }
        }
        R.draw(stage.scr);
      }
      FY.stats.ms += (performance.now() - work - FY.stats.ms) * 0.1;   // how long a frame takes to make
      FY.stats.grid = `${W}x${H}`;
      FY.stats.spin = chosen;
    }
    FY.stats = { ms: 0, grid: "" };
    requestAnimationFrame(frame);
  }

  main().catch((e) => {
    document.body.insertAdjacentHTML("beforeend", `<p class="oops">something went wrong: ${String(e && e.message || e)}</p>`);
  });
})();
