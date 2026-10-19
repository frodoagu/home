// A sound's cut and fades, like the one-shot box of Ableton's Simpler, laid
// over every hit or note it plays: `length` keeps that share of the event
// (of however long the voice rings), and `fadeIn` / `fadeOut` ramp its first
// and last shares of what is kept. Shares, not seconds, so one shape fits a
// short hit and a long pad note alike. A sample cuts with its own start and
// length instead (patterns.js `sample`): it only takes the fades from here.
import { SHAPE_PARAMS } from "./params.js";

export const SHAPE_DEFAULT = Object.fromEntries(SHAPE_PARAMS.map((p) => [p.key, p.def]));

// The shortest ramp to silence a cut gets: a sudden stop mid-waveform clicks.
export const CUT_RAMP = 0.005;

export const isFlat = (shape) => !shape || (shape.length >= 1 && !shape.fadeIn && !shape.fadeOut);

// The fades share what is kept: the fade-out gives way to the fade-in.
export function cleanShape(saved) {
  const out = { ...SHAPE_DEFAULT };
  if (!saved || typeof saved !== "object") return out;
  for (const p of SHAPE_PARAMS) {
    if (Number.isFinite(saved[p.key])) out[p.key] = Math.min(p.max, Math.max(p.min, saved[p.key]));
  }
  out.fadeOut = Math.min(out.fadeOut, Math.round((1 - out.fadeIn) * 100) / 100);
  return out;
}

// What a sample takes from the shape: its fades, never the voice's cut.
export const fadesOnly = (shape) => (shape ? { ...shape, length: 1 } : shape);

// The voices stop their own sources once they fall silent, so the latest
// stop they schedule is when an event ends. One view per context, so the
// voices' per-context caches (noise, waves) still hit.
const views = new WeakMap();
const SOURCES = /^create(\w*Source|Oscillator)$/;
function watched(ctx) {
  let view = views.get(ctx);
  if (!view) {
    const seen = { end: 0 };
    const track = (node) => {
      const stop = node.stop.bind(node);
      node.stop = (when = 0) => {
        seen.end = Math.max(seen.end, when);
        return stop(when);
      };
      return node;
    };
    const proxy = new Proxy(ctx, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (typeof v !== "function") return v;
        return SOURCES.test(key) ? (...args) => track(v.apply(target, args)) : v.bind(target);
      },
    });
    view = { proxy, seen };
    views.set(ctx, view);
  }
  return view;
}

/**
 * Runs `play(ctx)`, a voice scheduling one event at `t`, and returns when it
 * is silent: what the voice returns, if it says, else its latest stop.
 */
export function ringing(ctx, t, play) {
  const { proxy, seen } = watched(ctx);
  seen.end = t;
  const told = play(proxy);
  return Number.isFinite(told) ? told : seen.end;
}

/**
 * Plays one event through the shape: `play(out, ctx)` schedules the voice
 * at `t` into `out` on `ctx`. A flat shape adds no node and hands the voice
 * the context as it is. Returns when the shaped event is silent, or what
 * the voice returns for a flat one.
 */
export function shaped(ctx, out, t, shape, play) {
  if (isFlat(shape)) return play(out, ctx);
  const amp = ctx.createGain();
  amp.connect(out);
  const end = ringing(ctx, t, (c) => play(amp, c));
  const span = Math.max(0, end - t) * shape.length;
  const stop = t + span;
  const cut = shape.length < 1 || shape.fadeOut > 0;
  const fadeOut = cut ? Math.min(span, Math.max(CUT_RAMP, span * shape.fadeOut)) : 0;
  const fadeIn = Math.min(span * shape.fadeIn, span - fadeOut);
  const g = amp.gain;
  g.setValueAtTime(fadeIn > 0 ? 0 : 1, t);
  if (fadeIn > 0) g.linearRampToValueAtTime(1, t + fadeIn);
  if (cut) {
    g.setValueAtTime(1, stop - fadeOut);
    g.linearRampToValueAtTime(0, stop);
  }
  return cut ? stop : end;
}
