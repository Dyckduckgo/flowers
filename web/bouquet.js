/* bouquet.js - the garden on its own: a web port of flowers.py from terminal-art.
   a little bouquet grows out of the dark under the stars, then spins, and you steer it,
   to "Reflections" by Malcolm Todd (0:38-1:15, looping). */
"use strict";
(function () {
  const { C, TAU, clip, inkOf, spaced, BLUSH, MIST, ROSE } = FY;
  const CELL = 2.0;
  const LEAD = 0.39;               // the music starts this much before the garden: the spin begins on the big beat
  const CREDIT = "reflections · malcolm todd";

  FY.GardenMode = class GardenMode {
    constructor(app) {
      this.app = app;
      this.look = "letters";
      this.showCode = true;
      this.chosen = 0.25;                                       // turns a second, once it has bloomed
      this.code = new FY.Code(FY_SOURCES.flowers, 170, FY_SOURCES.builtins);
      this.stars = new FY.Stars();
      this.fps = 30;
      this.waiting = true;
    }

    resize(W, H) {
      this.W = W;
      this.H = H;
      this.scr = new FY.Screen(W, H);
      this.lay = new FY.Layout(W, H, FY.GARDEN_ASPECT, this.showCode, CELL);
      this.view = new FY.View(...this.lay.art, CELL);
    }

    enter(gesture) {
      this.waiting = !gesture;
      if (gesture) this.grow();
    }

    /** bare soil, and the song from the top (as soon as it has loaded). */
    grow() {
      const loop = this.app.loop;
      this.waiting = false;
      this.garden = new FY.Garden();
      this.sky = new FY.Sky();
      this.spin = this.speed = 0;
      this.paused = false;
      this.since = this.app.clock();
      this.music = loop.start();
      this.loading = !this.music && loop.available;            // still downloading: wait for it a moment
      this.start = this.app.clock();
    }

    leave() {
      this.app.loop.stop();
    }

    way() { return this.chosen >= 0 ? 1 : -1; }

    key(k) {
      if (this.waiting) {
        if (k !== "Enter" && k !== " ") return false;
        this.grow();
        return true;
      }
      const step = (v) => Math.round(v * 100) / 100;
      if (k === "ArrowUp" || k === "+" || k === "=" || k === "w") this.chosen = this.way() * Math.min(FY.MAX_SPIN, step(Math.abs(this.chosen) + 0.05));
      else if (k === "ArrowDown" || k === "-" || k === "_" || k === "s") this.chosen = this.way() * Math.max(0, step(Math.abs(this.chosen) - 0.05));
      else if (k === "ArrowRight" || k === "d") this.chosen = Math.min(FY.MAX_SPIN, step(this.chosen + 0.05));
      else if (k === "ArrowLeft" || k === "a") this.chosen = Math.max(-FY.MAX_SPIN, step(this.chosen - 0.05));
      else if (k === "r" || k === "R") this.chosen = -this.chosen;
      else if (k === " ") this.paused = !this.paused;
      else if (k === "g" || k === "G") this.grow();
      else if (k === "c" || k === "C") {
        this.showCode = !this.showCode;
        this.resize(this.W, this.H);
      } else if (k === "m" || k === "M") this.look = this.look === "hd" ? "letters" : "hd";
      else if (k === "Escape" || k === "q" || k === "Q" || k === "Backspace") this.app.go("gift");
      else return false;
      return true;
    }

    tap(cx, cy) {
      if (this.waiting) return this.grow();
      for (const h of this.hits || []) {
        if (cy === h.y && cx >= h.x0 - 1 && cx <= h.x1) return this.key(h.key);
      }
    }

    /** swipe up / down: faster / slower; sideways: push the spin that way. */
    drag(dx, dy) {
      this.dy = (this.dy || 0) + dy;
      this.dx = (this.dx || 0) + dx;
      for (; this.dy <= -28; this.dy += 28) this.key("ArrowUp");
      for (; this.dy >= 28; this.dy -= 28) this.key("ArrowDown");
      for (; this.dx >= 28; this.dx -= 28) this.key("ArrowRight");
      for (; this.dx <= -28; this.dx += 28) this.key("ArrowLeft");
    }

    wheel(dy) {
      this.roll = (this.roll || 0) + dy;
      for (; this.roll <= -100; this.roll += 100) this.key("ArrowUp");
      for (; this.roll >= 100; this.roll -= 100) this.key("ArrowDown");
    }

    frame(now, dt) {
      const scr = this.scr, app = this.app, v = this.view, lay = this.lay;
      scr.clear();
      this.hits = [];
      if (this.waiting) return this.cover(now);
      if (this.loading) {                                       // the song arrived: start both together
        if (app.loop.ready) {
          this.music = app.loop.start();
          this.loading = false;
          this.start = now;
        } else if (now - this.since > 6 || !app.loop.available) {
          this.loading = false;                                 // (it isn't coming: grow in silence)
          this.start = now;
        }
      }
      const t = this.loading ? 0 : Math.max(0, now - this.start - (this.music ? LEAD : 0));
      const grown = t > this.garden.done + 0.4;
      const target = this.paused || !grown ? 0 : this.chosen;
      this.speed += (target - this.speed) * Math.min(1, dt * 2.5);   // ease into any change of speed
      this.spin += this.speed * TAU * dt;
      this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.1;

      const [pts, tips] = this.garden.points(t, v.res);
      const depth = v.draw(scr, pts, t, this.spin, this.garden.phases, this.look);
      FY.moon(scr, v.ax, v.ay, v.aw, v.ah, CELL, this.look === "hd");
      this.stars.draw(scr, v.ax, v.ay, v.aw, v.ah, t);
      this.sky.draw(scr, v, depth, t, this.spin);
      this.sky.sparkle(tips, dt);
      let cells = 0;
      for (const d of depth) if (d !== Infinity) cells++;
      const drawn = this.look === "hd" ? `pixels ${(2 * cells).toLocaleString("en-US")}` : `letters ${cells.toLocaleString("en-US")}`;

      const [ax, ay, aw, ah] = lay.art;
      const stamp = ` t ${t.toFixed(2).padStart(5, "0")}s`;
      scr.put(ax + aw - stamp.length - 2, ay, "■", C.PINK);
      scr.put(ax + aw - stamp.length - 1, ay, stamp, C.PINK);
      const s = this.speed, way = this.paused ? "||" : s > 0.005 ? ">>" : s < -0.005 ? "<<" : "  ";
      const bar = Math.round((Math.abs(s) / FY.MAX_SPIN) * 10);
      const notes = [
        `a little garden · ${new Date().getFullYear()}` + (this.music ? `   ♪ ${CREDIT}` : ""),
        `bloom ${(100 * this.garden.bloom(t)).toFixed(1).padStart(5)}%   spin ${s >= 0 ? "+" : ""}${s.toFixed(2)} turns/s ${way}`,
        `${drawn}   [${"=".repeat(bar)}${"-".repeat(10 - bar)}]`,
      ];
      notes.forEach((text, i) => scr.put(ax + 1, ay + ah - 4 + i, text, C.HUD));
      this.help(scr, ax + 1, ay + ah - 1, aw - 2);
      this.status(scr);
      if (lay.code) {
        const [x, y, w, h] = lay.code;
        scr.put(x, y - 1, "─".repeat(w), C.RULE);
        this.code.draw(scr, x, y, w, h, t);
      }
      if (this.loading) scr.put(ax + 1, ay, "♪ loading the song ...", inkOf(MIST, 0.6));
      return scr;
    }

    /** the keys, as in flowers.py; on a phone, words you can tap. */
    help(scr, x, y, room) {
      if (!FY.TOUCH) {
        scr.put(x, y, "up/dn speed  <-/-> push  space pause  r flip  g regrow  m look".slice(0, room), C.RULE + 0x262630);
        return;
      }
      const parts = [["swipe ↑↓ speed ←→ push", null], ["pause", " "], ["flip", "r"], ["regrow", "g"], ["look", "m"]];
      for (const [label, key] of parts) {
        if (x + label.length > scr.w - 1 || label.length > room) break;
        scr.put(x, y, label, key ? C.PINK : C.RULE + 0x262630);
        if (key) this.hits.push({ x0: x, x1: x + label.length, y, key });
        x += label.length + 2;
        room -= label.length + 2;
      }
    }

    status(scr) {
      const [sx, sy, sw] = this.lay.status;
      scr.put(sx, sy, "$ py flowers.py", C.STATUS);
      const right = `running · ${this.fps.toFixed(0)} fps`;
      scr.put(sx + sw - right.length - 1, sy, right, C.HUD);
      const keys = FY.TOUCH ? [["‹ back", "Escape"], ["code", "c"]] : [["esc back", "Escape"], ["c code", "c"]];
      let x = sx + 17;
      for (const [label, key] of keys) {
        if (x + label.length > sx + sw - right.length - 2) break;
        scr.put(x, sy, label, FY.TOUCH ? C.PINK : C.RULE + 0x404050);
        this.hits.push({ x0: x, x1: x + label.length, y: sy, key });
        x += label.length + 3;
      }
    }

    /** reached straight from a link: a quiet title until a tap lets the music start. */
    cover(now) {
      const scr = this.scr, mid = Math.floor(this.H / 2);
      this.stars.draw(scr, 0, 0, this.W, this.H, now);
      const lines = [[spaced("a little garden"), inkOf(ROSE)], [`♪  ${CREDIT}`, inkOf(MIST, 0.6)], ["", 0],
        [`·   ${spaced(FY.TOUCH ? "tap to begin" : "press enter")}   ·`, inkOf(BLUSH, 0.6 + 0.3 * Math.sin(now * 2.4))]];
      lines.forEach(([text, colour], i) => {
        if (text) scr.put(Math.floor((this.W - FY.len(text)) / 2), mid - 2 + i, text, colour);
      });
      return scr;
    }
  };
})();
