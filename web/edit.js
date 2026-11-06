/* edit.js - the edit on its own: a web port of art.py from terminal-art.
   the video re-drawn live as glyph art on black, stars in the empty sky, a little HUD,
   and the program typing out its own source code while it plays. */
"use strict";
(function () {
  const { C, CODES, pack, inkOf, spaced, BLUSH, MIST, ROSE } = FY;
  const CELL = 2.0, FPS = 30;

  FY.EditMode = class EditMode {
    constructor(app) {
      this.app = app;
      this.look = "ascii";
      this.showCode = true;
      this.code = new FY.Code(FY_SOURCES.art, 170, FY_SOURCES.builtins);
      this.stars = new FY.Stars();
      this.fps = FPS;
      this.waiting = true;
    }

    resize(W, H) {
      this.W = W;
      this.H = H;
      this.scr = new FY.Screen(W, H);
      this.lay = new FY.Layout(W, H, this.app.video.aspect, this.showCode, CELL);
      const [, , vw, vh] = this.lay.video;
      this.glyph = new Uint8Array(vw * vh);
      this.fg = new Int32Array(vw * vh);
    }

    /** gesture: true when a tap or key brought us here (so the song may start right away). */
    enter(gesture) {
      this.waiting = !gesture;
      if (gesture) this.play();
    }

    play() {
      this.waiting = false;
      this.ended = false;
      this.ink = new FY.Ink();
      this.clock0 = this.app.clock();
      this.app.video.start();
    }

    leave() {
      this.app.video.stop();
    }

    key(k) {
      if (this.waiting) {
        if (k !== "Enter" && k !== " ") return false;
        this.play();
      } else if (k === "m" || k === "M") this.look = this.look === "ascii" ? "pixels" : "ascii";
      else if (k === "c" || k === "C") {
        this.showCode = !this.showCode;
        this.resize(this.W, this.H);
      } else if (k === "Escape" || k === "q" || k === "Q" || k === "Backspace") this.app.go("gift");
      else if ((k === "Enter" || k === " " || k === "r" || k === "R") && this.ended) this.play();
      else if ((k === "Enter" || k === " ") && this.app.video.blocked) this.app.video.unmute();
      else return false;
      return true;
    }

    tap(cx, cy) {
      if (this.waiting) return this.play();
      for (const h of this.hits || []) {
        if (cy === h.y && cx >= h.x0 - 1 && cx <= h.x1) return this.key(h.key);
      }
      if (this.app.video.blocked) this.app.video.unmute();
      else if (this.ended) this.play();
    }

    drag() {}

    wheel() {}

    frame(now, dt) {
      const scr = this.scr, app = this.app, video = app.video, lay = this.lay;
      scr.clear();
      this.hits = [];
      if (this.waiting) return this.cover(now);
      const clock = now - this.clock0, t = video.time();
      if (!this.ended && video.over()) this.ended = true;
      this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.1;
      const [vx, vy, vw, vh] = lay.video, sign = app.sign, signing = sign && (t >= sign.start || this.ended);
      let drawn = 0;
      const shot = !signing && video.ready() ? app.grab.get(video.v, vw * 4, vh * 8) : null;
      if (shot && this.look === "ascii") {                      // the rose look
        this.ink.run(shot, vw, vh, this.glyph, this.fg);
        for (let r = 0; r < vh; r++) {
          for (let c = 0; c < vw; c++) {
            const i = r * vw + c, a = (vy + r) * this.W + vx + c;
            scr.ch[a] = CODES[this.glyph[i]];
            scr.fg[a] = this.fg[i];
            if (this.glyph[i]) drawn++;
          }
        }
      } else if (shot) {                                        // sharp colour blocks: '▀', ink over paper
        for (let r = 0; r < vh; r++) {
          for (let c = 0; c < vw; c++) {
            const half = (y0) => {
              let R = 0, G = 0, B = 0;
              for (let y = y0; y < y0 + 4; y++) {
                for (let x = 0; x < 4; x++) {
                  const o = ((r * 8 + y) * vw * 4 + c * 4 + x) * 4;
                  R += shot[o];
                  G += shot[o + 1];
                  B += shot[o + 2];
                }
              }
              return pack(R / 4080, G / 4080, B / 4080);
            };
            const a = (vy + r) * this.W + vx + c;
            scr.ch[a] = 0x2580;
            scr.fg[a] = half(0);
            scr.bg[a] = half(4);
          }
        }
        drawn = vw * vh;
      }
      if (signing) {                                            // the closing card: your @, big enough to read
        sign.draw(scr, lay.video, vh, (this.ended ? Math.max(t, video.length) : t) - sign.start);
      }
      const [ax, ay, aw, ah] = lay.art;
      this.stars.draw(scr, ax, ay, aw, ah, clock);
      const stamp = ` t ${t.toFixed(2).padStart(5, "0")}s`;
      scr.put(ax + aw - stamp.length - 2, ay, "■", C.PINK);
      scr.put(ax + aw - stamp.length - 1, ay, stamp, C.PINK);
      const frames = Math.max(1, Math.trunc(video.length * FPS)), frame = Math.min(frames, Math.trunc(t * FPS));
      const lines = [
        `${sign ? sign.name : "feelings"} · ${new Date().getFullYear()}`,
        `frame ${String(frame).padStart(4, "0")}/${String(frames).padStart(4, "0")}   played ${((100 * frame) / frames).toFixed(1).padStart(5)}%`,
        `glyphs ${drawn.toLocaleString("en-US")}   look ${this.look}`,
      ];
      lines.forEach((text, i) => scr.put(ax + 1, ay + ah - 3 + i, text, C.HUD));
      this.status(scr);
      if (lay.code) {
        const [x, y, w, h] = lay.code;
        scr.put(x, y - 1, "─".repeat(w), C.RULE);
        this.code.draw(scr, x, y, w, h, clock);
      }
      if (video.blocked) this.say(scr, FY.TOUCH ? "tap for sound ♪" : "press enter for sound ♪");
      return scr;
    }

    /** $ py art.py, a few things you can tap or press, and how fast it's going. */
    status(scr) {
      const [sx, sy, sw] = this.lay.status;
      scr.put(sx, sy, "$ py art.py", C.STATUS);
      const right = this.ended ? (FY.TOUCH ? "ended · tap again" : "ended · enter again") : `running · ${this.fps.toFixed(0)} fps`;
      scr.put(sx + sw - right.length - 1, sy, right, C.HUD);
      const keys = FY.TOUCH ? [["‹ back", "Escape"], ["look", "m"], ["code", "c"]]
        : [["esc back", "Escape"], ["m look", "m"], ["c code", "c"]];
      let x = sx + 14;
      for (const [label, key] of keys) {
        if (x + label.length > sx + sw - right.length - 3) break;
        scr.put(x, sy, label, FY.TOUCH ? C.PINK : C.RULE + 0x404050);
        this.hits.push({ x0: x, x1: x + label.length, y: sy, key });
        x += label.length + 3;
      }
    }

    say(scr, text) {
      const [ax, ay, aw, ah] = this.lay.art;
      scr.put(ax + aw - text.length - 2, ay + ah - 2, text, inkOf(MIST, 0.8));
    }

    /** reached straight from a link: a quiet title until a tap lets the sound start. */
    cover(now) {
      const scr = this.scr, mid = Math.floor(this.H / 2);
      this.stars.draw(scr, 0, 0, this.W, this.H, now);
      const lines = [[spaced("feelings"), inkOf(ROSE)], ["the edit, re-drawn in letters", inkOf(MIST, 0.6)], ["", 0],
        [`·   ${spaced(FY.TOUCH ? "tap to begin" : "press enter")}   ♪`, inkOf(BLUSH, 0.6 + 0.3 * Math.sin(now * 2.4))]];
      lines.forEach(([text, colour], i) => {
        if (text) scr.put(Math.floor((this.W - FY.len(text)) / 2), mid - 2 + i, text, colour);
      });
      return scr;
    }
  };
})();
