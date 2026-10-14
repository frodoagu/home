// The show on screen: a full-window canvas, the frame loop that turns the
// source's events into uniforms (stage -> director -> renderer), and the VJ
// controls: keys, taps and swipes, and a HUD that hides itself.
//
// Used by the sampler's 🌀 (an overlay on this tab, straight off the engine)
// and by visuals.html (another window, or the microphone).

import { el } from "../ui/dom.js";
import { SCENES, createDirector } from "./director.js";
import { createFlight } from "./flight.js";
import { createMotion } from "./motion.js";
import { createRenderer } from "./renderer.js";
import { micSource, withIdle } from "./sources.js";
import { createStage } from "./stage.js";
import "./visuals.css";

const SETTINGS_KEY = "psy-sampler:visuals";
const HUD_MS = 2500; // the HUD and the cursor hide after this long without a move
const STROBE_STEPS = [1, 0.5, 0];
// How much of the last frame stays as a trail, per scene, before the energy.
export const TRAILS = {
  bulb: 0.55,
  kifs: 0.7,
  mandala: 0.78,
  flow: 0.4,
  julia: 0.6,
  gyroid: 0.55,
  coral: 0.55,
  cells: 0.5,
  phyllo: 0.6,
  hyper: 0.6,
  turing: 0.3,
  physarum: 0.5,
};
const SWIPE_PX = 60;
const HAZE = 0.35; // smoke in the air at rest; the energy thickens it
const GRAIN = 0.05; // film grain, at screen resolution
const MUSIC_MS = 800; // how fast the beat's pulse fades in and out with the music

// The key that does each thing; digits pick a scene, 0 the tenth.
export const KEYS = {
  " ": "next",
  ArrowRight: "next",
  ArrowLeft: "prev",
  l: "lock",
  p: "palette",
  f: "flash",
  s: "strobe",
  m: "mic",
  h: "hud",
  Enter: "fullscreen",
  Escape: "close",
};

/** What `key` does, or null: an action name, or { pick: index } for a digit, with `count` scenes. */
export function actionOf(key, count = SCENES.length) {
  if (/^[0-9]$/.test(key)) {
    const index = (Number(key) + 9) % 10;
    return index < count ? { pick: index } : null;
  }
  return KEYS[key] ?? KEYS[key.toLowerCase?.()] ?? null;
}

/** Stored settings: { strobe: 0..1, warned }, full strobe until changed. */
export function loadSettings(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "{}");
    const strobe = Number(raw?.strobe);
    return { strobe: Number.isFinite(strobe) ? Math.min(1, Math.max(0, strobe)) : 1, warned: raw?.warned === true };
  } catch {
    return { strobe: 1, warned: false };
  }
}

function saveSettings(storage, settings) {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: the settings last this visit.
  }
}

/**
 * Mounts the show into `root`. `source` is where the music comes from
 * (sources.js); `popOut` (optional) moves it to another window; `onClose`
 * runs when it is closed from inside. Returns { close }.
 */
export function mountShow({ root, source: initial, tx, storage, onClose, popOut = null, canClose = true }) {
  const settings = loadSettings(storage);
  const canvas = el("canvas", { class: "vis-canvas" });
  const node = el("div", { class: "vis", tabindex: "-1" }, canvas);
  root.append(node);

  const renderer = createRenderer(canvas, { sceneIds: SCENES.map((s) => s.id) });
  const scenes = renderer ? SCENES.filter((sc) => renderer.supports(sc.id)) : SCENES;
  if (!renderer) {
    node.append(el("p", { class: "vis-fail", text: tx.noWebgl }));
  }

  const base = withIdle(initial);
  let source = base;
  let micOn = false;
  const stage = createStage({ now: performance.now() });
  const director = createDirector({ scenes });
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const motion = createMotion({ shake: !still });
  const flight = createFlight({ turns: !still });
  let last = null; // the latest stage frame, for the keys
  let time = 0;
  let music = 0; // 1 while something plays, eased so a stop fades the beat out
  let prevNow = performance.now();
  let raf = 0;
  let closed = false;

  // HUD: what plays, the controls, the keys.
  const sceneName = el("strong", { class: "vis-scene" });
  const sourceName = el("span", { class: "vis-source" });
  const button = (action, label, title) => {
    const b = el("button", { type: "button", class: "vis-btn", "data-vis": action, text: label, title, "aria-label": title });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      act(action);
    });
    return b;
  };
  const lockBtn = button("lock", "🔒", tx.lock);
  const micBtn = button("mic", "🎤", tx.mic);
  const strobeId = "vis-strobe";
  const strobe = el("input", { type: "range", id: strobeId, min: "0", max: "100", step: "5", value: String(Math.round(settings.strobe * 100)) });
  strobe.addEventListener("input", () => {
    settings.strobe = Number(strobe.value) / 100;
    saveSettings(storage, settings);
  });
  strobe.addEventListener("click", (e) => e.stopPropagation());
  const hud = el(
    "div",
    { class: "vis-hud" },
    el("div", { class: "vis-now" }, sceneName, sourceName),
    el(
      "div",
      { class: "vis-controls" },
      button("prev", "⏮", tx.prev),
      button("next", "⏭", tx.next),
      lockBtn,
      button("palette", "🎨", tx.palette),
      button("flash", "⚡", tx.flash),
      el("label", { class: "vis-strobe", for: strobeId, title: tx.strobe }, el("span", { text: tx.strobe }), strobe),
      micBtn,
      ...(popOut ? [button("popout", "⧉", tx.popOut)] : []),
      button("fullscreen", "⛶", tx.fullscreen),
      ...(canClose ? [button("close", "✕", tx.close)] : []),
    ),
    el("p", { class: "vis-keys", text: tx.keys }),
  );
  node.append(hud);

  let hudTimer = 0;
  let hudHidden = false; // hidden with H: nothing but H brings it back
  function showHud() {
    if (hudHidden) return;
    node.classList.remove("vis-idle");
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => node.classList.add("vis-idle"), HUD_MS);
  }
  node.addEventListener("pointermove", showHud);
  showHud();

  // Photosensitivity warning, the first time only.
  if (!settings.warned) {
    const ok = el("button", { type: "button", class: "vis-btn vis-ok", text: tx.warning.ok });
    const warning = el(
      "div",
      { class: "vis-warning", role: "alertdialog", "aria-labelledby": "vis-warning-title" },
      el("h2", { id: "vis-warning-title", text: tx.warning.title }),
      el("p", { text: tx.warning.text }),
      ok,
    );
    ok.addEventListener("click", (e) => {
      e.stopPropagation();
      settings.warned = true;
      saveSettings(storage, settings);
      warning.remove();
    });
    node.append(warning);
  }

  const status = (text) => {
    sourceName.textContent = text;
    showHud();
  };

  function sourceLabel() {
    if (micOn) return tx.sources.mic;
    if (base.kind === "window") return base.live() ? tx.sources.window : tx.sources.waiting;
    if (base.kind === "sampler") return base.quiet() ? tx.sources.stopped : tx.sources.sampler;
    return tx.sources.idle;
  }

  async function toggleMic() {
    if (micOn) {
      source.stop();
      source = base;
      micOn = false;
      micBtn.setAttribute("aria-pressed", "false");
      return;
    }
    try {
      const mic = await micSource();
      if (closed) return mic.stop();
      source = mic;
      micOn = true;
      micBtn.setAttribute("aria-pressed", "true");
    } catch {
      status(tx.micDenied);
    }
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else node.requestFullscreen?.().catch(() => {});
  }

  function act(action) {
    showHud();
    if (typeof action === "object") return last && director.pick(last, action.pick);
    switch (action) {
      case "next":
        return last && director.next(last);
      case "prev":
        return last && director.prev(last);
      case "lock":
        lockBtn.setAttribute("aria-pressed", String(director.lock()));
        return;
      case "palette":
        return director.palette();
      case "flash":
        return director.flash(performance.now());
      case "strobe": {
        const i = STROBE_STEPS.findIndex((v) => v <= settings.strobe + 1e-3);
        settings.strobe = STROBE_STEPS[(i + 1) % STROBE_STEPS.length];
        strobe.value = String(Math.round(settings.strobe * 100));
        saveSettings(storage, settings);
        return status(`${tx.strobe} ${Math.round(settings.strobe * 100)}%`);
      }
      case "mic":
        return toggleMic();
      case "hud":
        hudHidden = !hudHidden;
        if (!hudHidden) return showHud();
        clearTimeout(hudTimer);
        return node.classList.add("vis-idle");
      case "fullscreen":
        return fullscreen();
      case "popout":
        return popOut?.();
      case "close":
        return canClose && close();
    }
  }

  // Keys: only the ones the show uses, kept from the page under it.
  function onKey(e) {
    if (e.target === strobe || e.metaKey || e.ctrlKey || e.altKey) return;
    const action = actionOf(e.key, scenes.length);
    if (!action) return;
    if (action === "close" && document.fullscreenElement) return; // the browser leaves fullscreen first
    e.preventDefault();
    e.stopPropagation();
    act(action);
  }
  addEventListener("keydown", onKey, true);

  // Taps and swipes: a tap shows the HUD (or flashes when it is showing), a
  // swipe sideways changes the scene, a double tap goes fullscreen.
  let down = null;
  let lastTap = 0;
  node.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  node.addEventListener("pointerup", (e) => {
    if (!down || e.target.closest(".vis-hud, .vis-warning")) return void (down = null);
    const dx = e.clientX - down.x;
    down = null;
    if (Math.abs(dx) > SWIPE_PX) return act(dx < 0 ? "next" : "prev");
    const now = performance.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      return fullscreen();
    }
    lastTap = now;
    if (node.classList.contains("vis-idle") && !hudHidden) showHud();
    else act("flash");
  });

  // The screen stays on while the show plays.
  let wake = null;
  const holdScreen = () => {
    if (document.visibilityState === "visible" && !closed) {
      navigator.wakeLock?.request("screen").then((lock) => (wake = lock), () => {});
    }
  };
  document.addEventListener("visibilitychange", holdScreen);
  holdScreen();

  let labelAt = 0;
  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(100, now - prevNow);
    prevNow = now;
    for (const e of source.poll(now)) stage.push(e);
    const s = stage.frame(now);
    last = s;
    const d = director.frame(s);
    const m = motion(s);
    // A vinyl brake slows the picture to a stop with the music.
    const seconds = (dt / 1000) * (0.5 + 0.9 * s.energy + 0.6 * s.build) * (1 - s.brake);
    time += seconds;
    const reef = [d.scene, d.previous].find((look) => look?.id === "coral");
    const fl = flight(s, seconds, m.push, reef?.vars ?? null);
    music += ((s.playing ? 1 : 0) - music) * (1 - Math.exp(-dt / MUSIC_MS));
    if (now - labelAt > 500) {
      labelAt = now;
      sceneName.textContent = `${tx.scenes[d.scene.id]}${d.locked ? " 🔒" : ""}`;
      sourceName.textContent = sourceLabel();
    }
    if (!renderer) return;
    const strobeLevel = settings.strobe;
    // The colours flip on the drop's off-8ths, and on every other 16th of a set's frenzy.
    const flips = (s.sinceDrop >= 0 && s.sinceDrop < 2 && Math.floor(s.sinceDrop * 2) % 2 === 1) || (s.frenzy > 0 && Math.floor(s.beats * 4) % 2 === 1);
    const invert = strobeLevel >= 0.75 && flips ? 1 : 0;
    renderer.render({
      uniforms: {
        uTime: time,
        uBeats: s.beats,
        uBeat: s.beat,
        uBar: s.barPhase,
        uKick: s.env.kick,
        uBass: s.env.bass,
        uPerc: s.env.perc,
        uLead: Math.max(s.env.lead, s.env.classic),
        uPad: s.env.pad,
        uGlitch: s.env.glitch,
        uFx: s.env.fx,
        uEnergy: s.energy,
        uBuild: s.build,
        uDrop: s.sinceDrop >= 0 ? Math.exp(-s.sinceDrop / 4) : 0,
        uLow: [s.levels.low, s.levels.mid, s.levels.high],
        uMusic: music,
        uPush: m.push,
        uSurge: m.surge,
        uHeart: m.heart,
        uShake: m.shake,
        uEye: fl.eye,
        uAhead: fl.ahead,
        uReach: fl.reach,
      },
      scene: d.scene,
      previous: d.previous,
      seconds,
      post: {
        uMix: d.mix,
        uStrobe: d.strobe * strobeLevel,
        uInvert: invert,
        uTrails: Math.min(0.92, TRAILS[d.scene.id] + 0.08 * s.energy),
        uHaze: HAZE + 0.25 * s.energy,
        uGrain: GRAIN,
      },
    });
    renderer.adapt(dt);
  }
  raf = requestAnimationFrame(loop);
  node.focus({ preventScroll: true });

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", holdScreen);
    wake?.release().catch(() => {});
    if (micOn) source.stop();
    base.stop();
    renderer?.destroy();
    if (document.fullscreenElement === node) document.exitFullscreen?.().catch(() => {});
    node.remove();
    onClose?.();
  }

  return { close, node, fullscreen };
}
