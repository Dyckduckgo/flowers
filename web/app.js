/* app.js - puts the page together: one canvas, three scenes (the gift, then the garden and the
   edit on their own), the keys, taps and swipes, and the clock. */
"use strict";
(function () {
  const FPS = 30;

  async function main() {
    const query = new URLSearchParams(location.search);
    const mute = query.has("mute");
    const D = window.FY_DATA;
    const [flowers, signature] = await Promise.all([FY.picture("flowers", D.flowers), FY.picture("signature", D.signature)]);
    FY.PICS = { flowers, signature };
    const R = new FY.Renderer(document.getElementById("screen"));
    const app = {
      clock: () => performance.now() / 1000,
      autostart: query.has("autostart") ? parseFloat(query.get("autostart")) || 6 : null,
      video: new FY.VideoSong(document.getElementById("song"), mute),
      loop: new FY.LoopSong("reflections.m4a", 37, mute),
      grab: new FY.Grab(),
      sign: new FY.Signature(signature, D),
    };
    const modes = { gift: new FY.GiftMode(app), garden: new FY.GardenMode(app), edit: new FY.EditMode(app) };
    FY.app = Object.assign(app, { modes });                     // (handy from the browser console)
    let mode = null;
    const fitted = (m) => {                                     // every scene laid out for this window
      if (m.size !== `${R.cols}x${R.rows}`) {
        m.resize(R.cols, R.rows);
        m.size = `${R.cols}x${R.rows}`;
      }
    };
    /** switch scenes. gesture: a tap or key led here, so sound may start straight away. */
    app.go = (name, gesture = true) => {
      if (mode && mode.leave) mode.leave();
      mode = modes[name];
      fitted(mode);
      mode.enter(gesture);
      history.replaceState(null, "", name === "gift" ? location.pathname + location.search : `#${name}`);
    };
    R.fit();
    const asked = location.hash.slice(1);                       // for-you.netlify.app/#garden opens the garden
    app.go(asked === "garden" || asked === "edit" ? asked : "gift", false);

    // ── input: every tap or key also wakes the sound (phones only allow it from one) ──
    const wake = () => {
      app.video.wake();
      app.loop.wake();
    };
    addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      wake();
      if (mode.key(e.key)) e.preventDefault();
    });
    let drag = null;
    addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; });
    addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved >= 12) mode.drag(dx, dy);
    });
    addEventListener("pointerup", () => { setTimeout(() => { drag = null; }, 0); });
    addEventListener("pointercancel", () => { drag = null; });
    // taps: on touch screens a touchend (iPhones send no click for a plain canvas, and a touchend
    // is what lets sound start); with a mouse, a click
    let touch = null, lastTouch = -1e9;
    const tap = (x, y) => {
      wake();
      mode.tap(...R.cellAt(x, y));
    };
    addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      touch = { x: t.clientX, y: t.clientY, moved: 0 };
    }, { passive: true });
    addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!touch) return;
      touch.moved += Math.abs(t.clientX - touch.x) + Math.abs(t.clientY - touch.y);
      touch.x = t.clientX;
      touch.y = t.clientY;
    }, { passive: true });
    addEventListener("touchend", (e) => {
      lastTouch = performance.now();
      if (touch && touch.moved < 12) {
        e.preventDefault();                                     // (no second, mouse-style click)
        tap(touch.x, touch.y);
      }
      touch = null;
    }, { passive: false });
    addEventListener("click", (e) => {
      if (performance.now() - lastTouch < 800) return;          // already handled as a touch
      if (!drag || drag.moved < 12) tap(e.clientX, e.clientY);
    });
    addEventListener("wheel", (e) => mode.wheel(e.deltaY), { passive: true });

    // ── the clock: about 30 pictures a second ──
    let last = app.clock();
    FY.stats = { ms: 0, grid: "", scene: "" };
    function frame(ms) {
      requestAnimationFrame(frame);
      const now = ms / 1000;
      if (now - last < 1 / FPS - 0.004) return;
      const dt = Math.min(now - last, 0.1);
      last = now;
      const work = performance.now();
      R.fit();
      fitted(mode);
      R.draw(mode.frame(now, dt));
      FY.stats.ms += (performance.now() - work - FY.stats.ms) * 0.1;   // how long a picture takes to make
      FY.stats.grid = `${R.cols}x${R.rows}`;
      FY.stats.scene = Object.keys(modes).find((k) => modes[k] === mode);
    }
    requestAnimationFrame(frame);
  }

  main().catch((e) => {
    document.body.insertAdjacentHTML("beforeend", `<p class="oops">something went wrong: ${String((e && e.message) || e)}</p>`);
  });
})();
