/* gift.js - i grew some flowers for you. a web port of for_you.py from terminal-art:
   a little card, and when it's opened a garden grows under the stars and turns,
   slowly, while the edit and its song play beside it. when the song is over the card
   comes back, with the way to the other two pieces: the garden on its own, and the edit. */
"use strict";
(function () {
  const { TAU, clip, mod, pack, dim, CODES, SPACE, HOT, ROSE, BLUSH, MIST, WINE, CYAN, inkOf, len, spaced } = FY;
  const SPIN = 0.12, CELL = 2.0;
  const at = (scr, x, y) => y * scr.w + x;
  const inside = (scr, x, y) => x >= 0 && x < scr.w && y >= 0 && y < scr.h;
  /** two quick beats, then a rest. */
  const heartbeat = (t) => {
    const p = mod(t, 1.15);
    return Math.exp(-((p / 0.07) ** 2)) + 0.65 * Math.exp(-(((p - 0.22) / 0.08) ** 2));
  };

  // ── the card ───────────────────────────────────────────────────────────────
  /** i grew some / flowers / for you, laid out inside one box of the screen. */
  class Poster {
    constructor(x, y, w, h, prompt) {
      const cols = Math.trunc(Math.min(w * 0.66, Math.max(0, h - 8) * 4.0));
      this.art = cols >= 18 ? FY.wordArt(cols, FY.PICS.flowers) : null;
      const rows = this.art ? this.art.rows : 1;
      const top = y + Math.max(0, Math.floor((h - (rows + 7)) / 2));
      this.box = [x, y, w, h];
      this.cols = this.art ? cols : len(spaced("flowers"));
      this.rows = rows;
      this.wx = x + Math.floor((w - this.cols) / 2);
      this.wy = top + 2;
      this.line1 = spaced("i grew some");
      this.line2 = spaced("for you");
      this.at1 = [this.wx + Math.trunc(this.cols * 0.04), top];
      this.at2 = [this.wx + Math.trunc(this.cols * 0.96) - this.line2.length - 3, top + 2 + rows + 1];
      this.prompt = prompt ? `·   ${spaced(prompt)}   ·` : "";
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
      if (t > 4.8 && shake === 0 && this.prompt) {                // and a soft nudge to begin
        scr.put(this.atp[0], this.atp[1], this.prompt, inkOf(BLUSH, Poster.glow(t)));
      }
    }

    static glow(t) {
      return Math.min(1, (t - 4.8) / 0.8) * (0.6 + 0.28 * Math.sin((t - 4.8) * 2.4));
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
            this.cell(scr, r, front, FY.CHARS.indexOf("*"), pack(1, 1, 1));
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
        const k = 0.35 + 0.65 * b;
        scr.ch[at(scr, x, y)] = b > 0.75 ? 42 : b > 0.4 ? 43 : 0xb7;
        scr.fg[at(scr, x, y)] = pack((BLUSH[0] * 0.6 + 0.4) * k, (BLUSH[1] * 0.6 + 0.4) * k, (BLUSH[2] * 0.6 + 0.4) * k);
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
        if (edge <= 0.05 || mod(d - t * 2.2, 10.0) >= 0.9 || scr.ch[i] !== SPACE || scr.bg[i]) continue;
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

  // ── the show: garden on one side, the edit on the other ────────────────────
  const CHOICES = [["again", "again"], ["the garden", "garden"], ["the edit", "edit"]];

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
      this.card = new Poster(...(this.edit || this.garden), null);
      this.sign = this.video ? sign : null;
      this.hits = [];
      this.pick = 0;                                            // the menu item the keys point at
    }

    compose(garden, sky, stars, ink, frame, t, songT, spin, length, ended, petals, dt) {
      const scr = this.scr, [gx, gy, gw, gh] = this.garden;
      scr.clear();
      const [pts, tips] = garden.points(t, this.view.res);
      const depth = this.view.draw(scr, pts, t, spin, garden.phases);
      FY.moon(scr, gx, gy, gw, gh, CELL);
      stars.draw(scr, 0, 0, this.W, this.H, t);
      if (petals) petals.draw(scr, t, dt, 0.6);                // the card's petals keep falling
      this.hits = [];
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
      } else if (ended !== null) {                              // the song is over: the card again,
        this.card.draw(scr, ended);                             // and where to go from here
        if (ended > 4.8) this.menu(scr, ended);
      }
      sky.draw(scr, this.view, depth, t, spin);
      this.title(scr, t);
      this.song(scr, songT, length, ended);
      return tips;
    }

    /** again · the garden · the edit: one line with keys, or a column of big targets on a phone. */
    menu(scr, age) {
      const [bx, by, bw, bh] = this.card.box, row = this.card.atp[1], glow = Poster.glow(age);
      const airy = CHOICES.map(([label]) => spaced(label)), sep = "   ·   ";
      const wide = airy.reduce((s, l) => s + l.length, 0) + sep.length * (CHOICES.length - 1);
      const stack = FY.TOUCH && row + 2 * (CHOICES.length - 1) < by + bh;
      const place = (i, label) => {
        const x = stack ? bx + Math.floor((bw - label.length) / 2) : place.x;
        const y = stack ? row + 2 * i : row;
        if (!stack) place.x += label.length + sep.length;
        const chosen = !FY.TOUCH && i === this.pick;
        if (chosen) {
          scr.put(x - 2, y, "›", inkOf(HOT, 0.6 + 0.4 * glow));
          scr.put(x + label.length + 1, y, "‹", inkOf(HOT, 0.6 + 0.4 * glow));
        }
        scr.put(x, y, label, inkOf(BLUSH, chosen ? 1 : FY.TOUCH ? 0.35 + glow * 0.75 : glow * 0.85));
        this.hits.push({ x0: x - 1, x1: x + label.length + 1, y, go: CHOICES[i][1] });
        if (!stack && i < CHOICES.length - 1) scr.put(x + label.length + 3, y, "·", inkOf(WINE, 1.6));
      };
      const labels = !stack && wide + 4 > bw ? CHOICES.map(([l]) => l) : airy;
      place.x = bx + Math.floor((bw - (labels.reduce((s, l) => s + l.length, 0) + sep.length * (CHOICES.length - 1))) / 2);
      labels.forEach((label, i) => place(i, label));
    }

    /** which menu item (if any) a tap at this cell means. */
    hit(cx, cy) {
      let best = null, near = 2;
      for (const h of this.hits) {
        const d = Math.abs(cy - h.y);
        if (cx >= h.x0 - 1 && cx <= h.x1 + 1 && d < near) {
          near = d;
          best = h.go;
        }
      }
      return best;
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

  // ── the gift, as one of the page's three scenes ────────────────────────────
  FY.GiftMode = class GiftMode {
    constructor(app) {
      this.app = app;
      this.stars = new FY.Stars();
      this.scene = "card";
      this.start = app.clock();
      this.chosen = SPIN;
      this.ended = null;
    }

    resize(W, H) {
      const app = this.app;
      this.W = W;
      this.H = H;
      this.scr = new FY.Screen(W, H);
      this.poster = new Poster(0, 0, W, H, FY.TOUCH ? "tap to open" : "press enter");
      this.petals = new FallingPetals(W, H);
      this.rings = new Rings(W, H, CELL);
      this.hadVideo = !app.video.failed;
      this.stage = new Stage(W, H, this.hadVideo ? app.video.aspect : null, app.sign);
    }

    enter() {}                                                  // (coming back: everything is where it was)

    leave() {
      if (this.scene === "show" && this.ended === null) {       // left mid-song: it's over, show the card
        this.ended = this.app.clock() - this.show;
      }
    }

    begin() {
      if (this.scene !== "card") return;
      this.scene = "leaving";
      this.left = this.app.clock();
      this.scr.clear();
      this.poster.draw(this.scr, 99);
      this.dust = new Dust(this.scr, [0, 0, this.W, this.H], CELL);
      if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(() => {});
    }

    again() {                                                   // from the very beginning
      if (this.scene !== "show") return;
      this.app.video.start();
      this.show = this.app.clock();
      this.garden = new FY.Garden();
      this.sky = new FY.Sky();
      this.ended = null;
      this.spin = this.speed = 0;
    }

    choose(go) {
      if (go === "again") this.again();
      else this.app.go(go);
    }

    faster() { this.chosen = Math.min(1.5, Math.round((this.chosen + 0.04) * 100) / 100); }
    slower() { this.chosen = Math.max(0, Math.round((this.chosen - 0.04) * 100) / 100); }

    key(k) {
      const video = this.app.video, menu = this.scene === "show" && this.ended !== null;
      if (k === "Enter" || k === " ") {
        if (this.scene === "card") this.begin();
        else if (video.blocked) video.unmute();
        else if (menu) this.choose(CHOICES[this.stage.pick][1]);
        else return false;
      } else if (menu && (k === "ArrowLeft" || k === "ArrowRight")) {
        this.stage.pick = mod(this.stage.pick + (k === "ArrowRight" ? 1 : -1), CHOICES.length);
      } else if (k === "r" || k === "R") this.again();
      else if (k === "g" || k === "G") { if (menu) this.app.go("garden"); else return false; }
      else if (k === "e" || k === "E") { if (menu) this.app.go("edit"); else return false; }
      else if (k === "ArrowUp" || k === "+" || k === "=") this.faster();
      else if (k === "ArrowDown" || k === "-" || k === "_") this.slower();
      else return false;
      return true;
    }

    tap(cx, cy) {
      const video = this.app.video;
      if (this.scene === "card") this.begin();
      else if (this.scene === "show" && video.blocked) video.unmute();
      else if (this.scene === "show" && this.ended !== null) {
        const go = this.stage.hit(cx, cy);
        if (go) this.choose(go);
      }
    }

    drag(dx, dy) {                                              // swipe up / down: faster / slower
      this.step = (this.step || 0) + dy;
      for (; this.step <= -28; this.step += 28) this.faster();
      for (; this.step >= 28; this.step -= 28) this.slower();
    }

    wheel(dy) {
      this.roll = (this.roll || 0) + dy;
      for (; this.roll <= -100; this.roll += 100) this.faster();
      for (; this.roll >= 100; this.roll -= 100) this.slower();
    }

    frame(now, dt) {
      const app = this.app, video = app.video;
      if (this.hadVideo !== !video.failed) this.resize(this.W, this.H);
      if (this.scene === "card") {
        if (app.autostart !== null && now - this.start > app.autostart) this.begin();
        const t = now - this.start, scr = this.scr;
        scr.clear();
        this.rings.draw(scr, t);
        this.stars.draw(scr, 0, 0, this.W, this.H, t);
        this.petals.draw(scr, t, dt);
        this.poster.draw(scr, t);
        return scr;
      }
      if (this.scene === "leaving") {                           // a glitch, then glitter
        const age = now - this.left, t = now - this.start, scr = this.scr;
        scr.clear();
        this.stars.draw(scr, 0, 0, this.W, this.H, t);
        this.petals.draw(scr, t, dt, Math.max(0, 1 - age));
        if (age < 0.45) {
          this.rings.draw(scr, t, 1 - age / 0.45);
          this.poster.draw(scr, 99, 0.5 + age);
        } else this.dust.draw(scr, age - 0.45);
        if (age > 1.45) {
          this.scene = "show";
          this.show = now;
          this.garden = new FY.Garden();
          this.sky = new FY.Sky();
          this.ink = new FY.Ink();
          this.spin = this.speed = 0;
          this.chosen = SPIN;
          this.ended = null;
          video.start();
        }
        return scr;
      }
      const stage = this.stage, t = now - this.show;           // the show
      const songT = this.ended === null ? video.time() : video.length;   // (over: the bar stays full)
      let shot = null;
      if (stage.video && this.ended === null) {
        const signing = stage.sign && songT >= stage.sign.start;   // (the name needs no picture)
        if (video.over()) this.ended = t;
        else if (video.ready()) shot = signing ? true : app.grab.get(video.v, stage.video[2] * 4, stage.video[3] * 8);
      }
      const target = t > this.garden.done + 0.4 ? this.chosen : 0;
      this.speed += (target - this.speed) * Math.min(1, dt * 1.5);
      this.spin += this.speed * TAU * dt;
      const tips = stage.compose(this.garden, this.sky, this.stars, this.ink, shot, t, songT, this.spin,
        this.hadVideo ? video.length : 0, this.ended === null ? null : t - this.ended, this.petals, dt);
      this.sky.sparkle(tips, dt);
      if (video.blocked) {
        stage.note(FY.TOUCH ? "tap for sound ♪" : "press enter for sound ♪", 0.55 + 0.35 * Math.sin(now * 3));
      } else {
        const since = t - this.garden.done - 0.4;               // once it starts to turn: how to steer it
        if (since > 0 && since < 6 && this.ended === null) {
          stage.note(FY.TOUCH ? "swipe ↑ ↓ to spin" : "↑ ↓  spin faster / slower", 0.6 * Math.min(1, since, 6 - since));
        }
      }
      return stage.scr;
    }
  };
})();
