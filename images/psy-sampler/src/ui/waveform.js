// The waveform in a sound's editor, Simpler style: the wave as the sound
// plays it (faint) and as the shape leaves it (solid), the gain line over
// it, and four markers to drag: the start and end of a sample (a voice only
// has its end, its cut) along the bottom, the fade-in and fade-out along the
// top. A click away from the markers plays the sound. The sliders under it
// set the same values from the keyboard; the math is in ../waveform.js.
import { dragTo, gainLine, markers, peaks, pick } from "../waveform.js";
import { el } from "./dom.js";

const HEIGHT = 112; // css px
const REACH = 10; // css px either side of a marker that still grabs it
const PAD = 8; // css px kept clear above and below the wave

/**
 * load(): Promise of { sampleRate, data, whole } (engine.js sketch) or null.
 * get(): { shape, sample } now. onDrag(next): a marker moved, { shape, sample }.
 */
export function createWaveform({ load, get, onDrag, onPlay, label }) {
  const canvas = el("canvas", { class: "wave-canvas", role: "img", "aria-label": label });
  const node = el("div", { class: "wave" }, canvas);
  let wave = null; // { data, whole }
  let columns = null; // peaks() for the current width
  let asked = 0;
  let drag = null; // the marker key while one is held

  // A sample's markers only mean something on the sample itself: while it is
  // not decoded the voice plays, cut by the shape.
  const now = () => {
    const { shape, sample } = get();
    return { shape, sample: wave?.whole ? sample : null };
  };

  function at(e) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: (e.clientY - r.top) / r.height, width: r.width };
  }

  function draw() {
    const width = canvas.clientWidth;
    const ctx = width && canvas.getContext("2d");
    if (!ctx) return;
    const ratio = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(HEIGHT * ratio);
      columns = null;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const css = getComputedStyle(canvas);
    const color = (name) => css.getPropertyValue(name).trim();
    const [layer, text, muted, veil] = ["--layer", "--text", "--muted", "--veil"].map(color);
    ctx.clearRect(0, 0, width, HEIGHT);
    if (!wave) return;

    const { shape, sample } = now();
    const marks = markers(shape, sample);
    const line = gainLine(shape, sample);
    const gainAt = (x) => {
      if (x < marks.start || x > marks.end) return 0;
      for (let i = 1; i < line.length; i++) {
        const [x0, g0] = line[i - 1];
        const [x1, g1] = line[i];
        if (x <= x1) return x1 > x0 ? g0 + ((g1 - g0) * (x - x0)) / (x1 - x0) : g1;
      }
      return line.at(-1)[1];
    };
    columns ??= peaks(wave.data, Math.max(1, Math.floor(width)));
    const top = columns.reduce((m, [lo, hi]) => Math.max(m, -lo, hi), 0) || 1;
    const mid = HEIGHT / 2;
    const half = mid - PAD;
    const px = (x) => x * width;
    for (const [pass, fill] of [["faint", muted], ["solid", layer]]) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = pass === "faint" ? 0.35 : 1;
      columns.forEach(([lo, hi], c) => {
        const g = pass === "faint" ? 1 : gainAt((c + 0.5) / columns.length);
        if (!g) return;
        const y0 = mid - (hi / top) * half * g;
        const y1 = mid - (lo / top) * half * g;
        ctx.fillRect(c, y0, 1, Math.max(1, y1 - y0));
      });
    }
    ctx.globalAlpha = 1;

    // What never plays, veiled.
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, px(marks.start), HEIGHT);
    ctx.fillRect(px(marks.end), 0, width - px(marks.end), HEIGHT);

    // The gain line, from the bottom (silence) to the top (full).
    const gy = (g) => HEIGHT - PAD - g * (HEIGHT - 2 * PAD);
    ctx.strokeStyle = text;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    line.forEach(([x, g], i) => (i ? ctx.lineTo(px(x), gy(g)) : ctx.moveTo(px(x), gy(g))));
    ctx.stroke();

    // The cut markers: full-height lines, flagged at the bottom; the fades: squares on the line.
    for (const key of sample ? ["start", "end"] : ["end"]) {
      const x = Math.round(px(marks[key])) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
      const dir = key === "start" ? 1 : -1;
      ctx.fillStyle = text;
      ctx.beginPath();
      ctx.moveTo(x, HEIGHT);
      ctx.lineTo(x, HEIGHT - 10);
      ctx.lineTo(x + dir * 8, HEIGHT - 5);
      ctx.fill();
    }
    ctx.fillStyle = text;
    for (const key of ["fadeIn", "fadeOut"]) {
      const x = px(marks[key]);
      ctx.fillRect(x - 4, gy(1) - 4, 8, 8);
    }
  }

  async function reload() {
    const mine = ++asked;
    node.dataset.state = "loading";
    let next;
    try {
      next = await load();
    } catch {
      next = null;
    }
    if (mine !== asked) return; // a newer load is on its way
    wave = next && { data: next.data, whole: next.whole };
    columns = null;
    node.dataset.state = wave ? "ready" : "empty";
    draw();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!wave) return;
    const p = at(e);
    const { shape, sample } = now();
    const key = pick(markers(shape, sample), p.x, p.y, REACH / p.width, sample);
    if (!key) {
      onPlay();
      return;
    }
    drag = key;
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = at(e);
    if (!drag) {
      const { shape, sample } = now();
      const key = wave && pick(markers(shape, sample), p.x, p.y, REACH / p.width, sample);
      canvas.style.cursor = key ? "ew-resize" : wave ? "pointer" : "";
      return;
    }
    const { shape, sample } = now();
    const next = dragTo(drag, p.x, shape, sample);
    // The sample the drag moved is the stored one, not the null now() lends a voice.
    onDrag({ shape: next.shape, sample: sample ? next.sample : get().sample });
    draw();
  });
  const release = () => {
    drag = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  let sizes = null;
  if (typeof ResizeObserver !== "undefined") {
    sizes = new ResizeObserver(() => draw());
    sizes.observe(canvas);
  }

  return { node, reload, draw, destroy: () => sizes?.disconnect() };
}
