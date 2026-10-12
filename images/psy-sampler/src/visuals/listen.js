// Hearing music the show was not told about: levels per band off an
// AnalyserNode, kicks and hats from the jumps in those levels, and a tempo
// from the time between kicks. What it hears becomes the same events the
// sampler sends (stage.js), so the show does not know the difference.

const BANDS = { low: [35, 150], mid: [150, 2000], high: [4000, 12000] };
const HISTORY_MS = 1500; // the jumps a threshold is measured against
const MIN_GAP = { kick: 230, perc: 90 }; // ms between two onsets of one kind
const SENSITIVITY = { kick: 1.6, perc: 1.9 }; // standard deviations above the mean
const FLOOR = { kick: 0.04, perc: 0.03 };
const BPM_RANGE = [110, 180];
const KICKS_KEPT = 24;
const BREAK_BEATS = 6; // this long without a kick is a breakdown

/** Mean of each band of `freq` (getByteFrequencyData), 0..1. */
export function bandsOf(freq, sampleRate) {
  const hz = sampleRate / 2 / freq.length;
  const out = {};
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    const from = Math.max(0, Math.floor(lo / hz));
    const to = Math.min(freq.length, Math.max(from + 1, Math.ceil(hi / hz)));
    let sum = 0;
    for (let i = from; i < to; i++) sum += freq[i];
    out[name] = sum / (to - from) / 255;
  }
  return out;
}

// One band's onsets: a rise well above what the band has been rising lately.
function onsetDetector(kind) {
  let prev = 0;
  let lastOnset = -Infinity;
  const flux = []; // [time, rise]
  return (time, value) => {
    const rise = Math.max(0, value - prev);
    prev = value;
    while (flux.length && flux[0][0] < time - HISTORY_MS) flux.shift();
    const n = flux.length;
    const mean = n ? flux.reduce((a, [, r]) => a + r, 0) / n : 0;
    const sd = n ? Math.sqrt(flux.reduce((a, [, r]) => a + (r - mean) ** 2, 0) / n) : 0;
    flux.push([time, rise]);
    if (rise > Math.max(FLOOR[kind], mean + SENSITIVITY[kind] * sd) && time - lastOnset >= MIN_GAP[kind]) {
      lastOnset = time;
      return true;
    }
    return false;
  };
}

/**
 * The beat length (ms) that best explains the gaps between `kicks` (times,
 * ms): every gap folded by octaves into BPM_RANGE, voted into 4 ms bins with
 * their neighbours. null with fewer than four kicks.
 */
export function beatOf(kicks) {
  if (kicks.length < 4) return null;
  const [slow, fast] = [60000 / BPM_RANGE[0], 60000 / BPM_RANGE[1]];
  const votes = new Map();
  for (let i = 1; i < kicks.length; i++) {
    let gap = kicks[i] - kicks[i - 1];
    if (gap <= 0) continue;
    while (gap > slow) gap /= 2;
    while (gap < fast) gap *= 2;
    if (gap > slow) continue;
    const bin = Math.round(gap / 4);
    for (const [b, w] of [[bin - 1, 0.5], [bin, 1], [bin + 1, 0.5]]) votes.set(b, (votes.get(b) ?? 0) + w);
  }
  let best = null;
  for (const [bin, v] of votes) if (!best || v > best.v) best = { bin, v };
  if (!best) return null;
  // The mean of the gaps in the winning bin, for a tempo finer than the bins.
  const near = [];
  for (let i = 1; i < kicks.length; i++) {
    let gap = kicks[i] - kicks[i - 1];
    while (gap > slow) gap /= 2;
    while (gap < fast) gap *= 2;
    if (Math.abs(gap / 4 - best.bin) <= 1.5) near.push(gap);
  }
  return near.reduce((a, b) => a + b, 0) / near.length;
}

/**
 * Feeds on band levels once per frame and returns the stage events they
 * mean: levels every time, hits on onsets, a bar line every four beats once
 * there is a tempo, a drop when the kick comes back after a breakdown.
 */
export function createListener({ bpm = 140 } = {}) {
  const kickOnset = onsetDetector("kick");
  const percOnset = onsetDetector("perc");
  const kicks = [];
  let beatMs = 60000 / bpm;
  let anchor = null; // time of a beat: the latest kick on the grid
  let nextBar = null; // { time, bar } of the next bar line to send
  let quiet = true; // in a breakdown (or not started)

  return function hear(time, bands) {
    const out = [{ kind: "levels", ...bands }];
    if (kickOnset(time, bands.low)) {
      if (quiet && kicks.length && time - kicks[kicks.length - 1] > BREAK_BEATS * beatMs) {
        out.push({ kind: "drop", time });
        out.push({ kind: "lanes", time, variants: ["kick", "bass", "perc", "lead"] });
      }
      if (quiet && !kicks.length) out.push({ kind: "lanes", time, variants: ["kick", "bass", "perc", "lead"] });
      quiet = false;
      kicks.push(time);
      if (kicks.length > KICKS_KEPT) kicks.shift();
      beatMs = beatOf(kicks) ?? beatMs;
      anchor = time;
      out.push({ kind: "hit", layer: "kick", time, accent: bands.low > 0.7 });
      out.push({ kind: "hit", layer: "bass", time: time + beatMs / 2 });
      if (!nextBar) nextBar = { time, bar: 0 };
    }
    if (percOnset(time, bands.high)) out.push({ kind: "hit", layer: "perc", time });
    if (!quiet && kicks.length && time - kicks[kicks.length - 1] > BREAK_BEATS * beatMs) {
      quiet = true;
      out.push({ kind: "lanes", time, variants: ["pad", "lead"] });
    }
    // Bar lines keep coming through a breakdown, on the grid the kicks laid.
    if (nextBar && time >= nextBar.time) {
      out.push({ kind: "bar", time: nextBar.time, bar: nextBar.bar, bpm: 60000 / beatMs });
      // The next one, snapped to the beat the latest kick sits on.
      let t = nextBar.time + 4 * beatMs;
      if (anchor !== null) t = anchor + Math.round((t - anchor) / beatMs) * beatMs;
      if (t <= nextBar.time) t += 4 * beatMs;
      nextBar = { time: t, bar: nextBar.bar + 1 };
    }
    return out;
  };
}
