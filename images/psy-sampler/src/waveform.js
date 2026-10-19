// The editor's waveform box (ui/waveform.js), its math: where the markers
// sit on the drawing, where a drag takes them, the gain line drawn over the
// wave and the peaks each column of pixels draws. Positions are shares of
// the drawing's width. A sample's drawing is the whole sample, and its start
// and end mark the part that plays; a voice's is one event, from 0 to its cut.
import { SAMPLE_PARAMS, SHAPE_PARAMS } from "./audio/params.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (v) => Math.round(v * 100) / 100; // the sliders' 0.01 steps
const spec = (list, key) => list.find((p) => p.key === key);
const START = spec(SAMPLE_PARAMS, "start");
const LENGTH = spec(SAMPLE_PARAMS, "length");
const CUT = spec(SHAPE_PARAMS, "length");

export function markers(shape, sample) {
  const start = sample ? sample.start : 0;
  const end = sample ? start + (1 - start) * sample.length : shape.length;
  const span = end - start;
  return { start, end, fadeIn: start + span * shape.fadeIn, fadeOut: end - span * shape.fadeOut };
}

/**
 * The marker a pointer at (x, y) grabs, both shares of the box, or null. The
 * fades hang from the top edge and the cut from the bottom, so the height
 * tells which pair; the nearest one within `reach` wins. A voice's start
 * never moves.
 */
export function pick(marks, x, y, reach, sample) {
  const keys = y < 0.5 ? ["fadeIn", "fadeOut"] : sample ? ["start", "end"] : ["end"];
  let best = null;
  for (const key of keys) {
    const d = Math.abs(marks[key] - x);
    if (d <= reach && (!best || d < best.d)) best = { key, d };
  }
  return best?.key ?? null;
}

/** { shape, sample } with `key` dragged to x. A start drag leaves the end where it was. */
export function dragTo(key, x, shape, sample) {
  const m = markers(shape, sample);
  const span = Math.max(m.end - m.start, 1e-6);
  const room = (other) => snap(1 - other); // what the other fade leaves
  switch (key) {
    case "start": {
      if (!sample) return { shape, sample };
      const start = snap(clamp(x, START.min, Math.min(START.max, m.end - LENGTH.min)));
      const length = snap(clamp((m.end - start) / (1 - start), LENGTH.min, LENGTH.max));
      return { shape, sample: { ...sample, start, length } };
    }
    case "end":
      if (sample) {
        const length = snap(clamp((x - m.start) / (1 - m.start), LENGTH.min, LENGTH.max));
        return { shape, sample: { ...sample, length } };
      }
      return { shape: { ...shape, length: snap(clamp(x, CUT.min, CUT.max)) }, sample };
    case "fadeIn":
      return { shape: { ...shape, fadeIn: snap(clamp((x - m.start) / span, 0, room(shape.fadeOut))) }, sample };
    case "fadeOut":
      return { shape: { ...shape, fadeOut: snap(clamp((m.end - x) / span, 0, room(shape.fadeIn))) }, sample };
    default:
      return { shape, sample };
  }
}

/**
 * The gain each event follows, as [x, gain] points from start to end. It
 * drops to silence at the end when something cuts there: a fade-out, a
 * voice's cut, or a sample's end before its last frame.
 */
export function gainLine(shape, sample) {
  const m = markers(shape, sample);
  const cut = shape.fadeOut > 0 || m.end < 1;
  return [
    [m.start, shape.fadeIn > 0 ? 0 : 1],
    [m.fadeIn, 1],
    [m.fadeOut, 1],
    [m.end, cut ? 0 : 1],
  ];
}

/** Per column: [min, max] of the frames it covers. */
export function peaks(data, columns) {
  const out = [];
  const per = data.length / columns;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * per);
    const to = Math.max(from + 1, Math.floor((c + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to && i < data.length; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    out.push([lo, hi]);
  }
  return out;
}
