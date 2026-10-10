// What the editors can change. Each spec is one slider: values are kept in the
// units the voice uses (Hz, seconds, bars) and `fmt` turns them into the
// readout. `label` is a key of the dictionaries' `params`.
import { t } from "../i18n/index.js";

// The defaults here are the ones the voices fall back to; a variant can start
// from different values (patterns.js), but always within [min, max].

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const ms = (v) => `${Math.round(v * 1000)} ms`;
const sec = (v) => `${v.toFixed(1)} s`;
const pct = (v) => `${Math.round(v * 100)} %`;
const times = (v) => `×${v.toFixed(2)}`;
const bars = (v) => t().bars(v);
const count = (v) => `×${v}`;
const octaves = (v) => `${v} oct`;
const semis = (v) => `${v > 0 ? "+" : ""}${v} st`;

const tone = (def, min, max, label = "tone") => ({ key: "tone", label, min, max, step: 10, def, fmt: hz });
const decay = (def, min, max, step = 0.005, fmt = ms) => ({ key: "decay", label: "decay", min, max, step, def, fmt });
const length = (def) => ({ key: "bars", label: "length", min: 1, max: 4, step: 1, def, fmt: bars });

export const PARAMS = {
  /* drum voices */
  kick: [
    { key: "f0", label: "startPitch", min: 80, max: 260, step: 1, def: 170, fmt: hz },
    { key: "f1", label: "endPitch", min: 30, max: 90, step: 1, def: 50, fmt: hz },
    { key: "sweep", label: "pitchDrop", min: 0.02, max: 0.25, step: 0.005, def: 0.07, fmt: ms },
    decay(0.2, 0.06, 0.7),
    { key: "click", label: "click", min: 0, max: 1, step: 0.05, def: 1, fmt: pct },
  ],
  hat: [tone(7000, 3000, 12000, "hpCut"), decay(0.14, 0.03, 0.5)],
  chat: [tone(9000, 4000, 14000, "hpCut"), decay(0.035, 0.015, 0.15)],
  shaker: [tone(6500, 2000, 10000, "band"), decay(0.045, 0.015, 0.2)],
  clap: [tone(1800, 800, 4000, "band"), decay(0.17, 0.06, 0.5)],
  snare: [tone(190, 120, 320), decay(0.15, 0.05, 0.4)],
  ride: [tone(9000, 5000, 12000, "band"), decay(0.45, 0.1, 1.2, 0.01)],
  rim: [tone(1700, 800, 3500), decay(0.04, 0.015, 0.15)],

  /* glitch voices */
  stutter: [
    tone(2500, 500, 9000, "band"),
    { key: "repeats", label: "repeats", min: 2, max: 8, step: 1, def: 4, fmt: count },
    decay(0.012, 0.004, 0.04),
  ],
  blip: [
    tone(1200, 200, 5000),
    { key: "spread", label: "spread", min: 0, max: 4, step: 0.5, def: 2, fmt: octaves },
    decay(0.04, 0.01, 0.2),
  ],
  zip: [
    tone(180, 60, 800, "endPitch"),
    { key: "sweep", label: "pitchDrop", min: 0.005, max: 0.1, step: 0.005, def: 0.03, fmt: ms },
    decay(0.08, 0.02, 0.3),
  ],
  crush: [
    tone(3000, 500, 8000),
    { key: "bits", label: "bits", min: 2, max: 6, step: 1, def: 3, fmt: (v) => `${v} bit` },
    decay(0.05, 0.015, 0.25),
  ],
  metal: [
    tone(600, 150, 2500),
    { key: "ratio", label: "ratio", min: 1.1, max: 5, step: 0.01, def: 2.76, fmt: times },
    decay(0.12, 0.03, 0.5),
  ],
  ring: [
    tone(900, 100, 4000),
    { key: "ring", label: "ring", min: 50, max: 4000, step: 10, def: 1370, fmt: hz },
    decay(0.09, 0.02, 0.4),
  ],
  crackle: [
    tone(4000, 1000, 12000, "hpCut"),
    { key: "density", label: "density", min: 1, max: 12, step: 1, def: 4, fmt: count },
  ],
  rise: [
    tone(300, 80, 2000, "startPitch"),
    { key: "sweep", label: "sweep", min: 0.02, max: 0.25, step: 0.005, def: 0.08, fmt: ms },
  ],
  tape: [tone(800, 200, 3000, "startPitch"), decay(0.18, 0.05, 0.6)],
  laser: [tone(4000, 1000, 8000, "from"), decay(0.15, 0.04, 0.6, 0.01)],

  /* every melodic synth */
  synth: [{ key: "bright", label: "bright", min: 0.25, max: 4, step: 0.05, def: 1, fmt: times }],

  /* one-shot FX */
  "fx.riser": [length(2), { key: "top", label: "to", min: 2000, max: 15000, step: 100, def: 9000, fmt: hz }],
  "fx.riserImpact": [length(2)],
  "fx.down": [length(1), { key: "from", label: "from", min: 2000, max: 12000, step: 100, def: 8000, fmt: hz }],
  "fx.sweep": [length(1), { key: "top", label: "peak", min: 1500, max: 12000, step: 100, def: 6000, fmt: hz }],
  "fx.impact": [
    { key: "f0", label: "tone", min: 50, max: 160, step: 1, def: 90, fmt: hz },
    decay(1.5, 0.4, 3, 0.1, sec),
  ],
  "fx.crash": [tone(6000, 3000, 10000, "hpCut"), decay(2, 0.5, 4, 0.1, sec)],
  "fx.siren": [length(1), { key: "rate", label: "vibrato", min: 2, max: 12, step: 0.5, def: 7, fmt: (v) => `${v} Hz` }],
  "fx.reverse": [length(2), tone(5000, 2000, 10000, "hpCut")],
  "fx.stutter": [length(1), { key: "top", label: "to", min: 1500, max: 12000, step: 100, def: 6000, fmt: hz }],
  "fx.tapeStop": [
    { key: "f0", label: "from", min: 100, max: 2000, step: 10, def: 600, fmt: hz },
    decay(0.8, 0.2, 2, 0.05, sec),
  ],
};

// A sample playing in place of a sound's own voice (patterns.js `sample`).
export const SAMPLE_PARAMS = [
  { key: "pitch", label: "pitch", min: -24, max: 24, step: 1, def: 0, fmt: semis },
  { key: "start", label: "start", min: 0, max: 0.95, step: 0.01, def: 0, fmt: pct },
  { key: "length", label: "length", min: 0.02, max: 1, step: 0.01, def: 1, fmt: pct },
];

// Every sound's filter and distortion (insert.js). `log`: the slider moves
// evenly in octaves, not in Hz.
export const INSERT_PARAMS = [
  { key: "cutoff", label: "cutoff", min: 40, max: 16000, step: 1, def: 1200, fmt: hz, log: true },
  { key: "res", label: "resonance", min: 0.5, max: 20, step: 0.1, def: 1, fmt: (v) => v.toFixed(1) },
  { key: "lfo", label: "lfo", min: 0, max: 1, step: 0.05, def: 0, fmt: pct },
  { key: "amount", label: "drive", min: 0, max: 1, step: 0.05, def: 0.4, fmt: pct },
];

// Every variant, of any kind, also gets a volume relative to its layer's level.
export const LEVEL = { key: "level", label: "volume", min: 0, max: 1.5, step: 0.05, def: 1, fmt: pct };

export const paramDefaults = (specId) => Object.fromEntries((PARAMS[specId] ?? []).map((p) => [p.key, p.def]));

// Instruments a melodic variant can play through (voices.js INSTRUMENTS).
// Names and descriptions live in the dictionaries' `synths`; the
// descriptions reference the Ableton devices whose basic patch each imitates.
export const SYNTHS = [
  { id: "bass", group: "bass" },
  { id: "sub", group: "bass" },
  { id: "fmBass", group: "bass" },
  { id: "reese", group: "bass" },
  { id: "acid", group: "lead" },
  { id: "supersaw", group: "lead" },
  { id: "analog", group: "lead" },
  { id: "pluck", group: "lead" },
  { id: "arp", group: "lead" },
  { id: "lead", group: "lead" },
  { id: "fmBell", group: "lead" },
  { id: "zap", group: "lead" },
  { id: "bitLead", group: "lead" },
  { id: "chirp", group: "lead" },
  { id: "pad", group: "pad" },
  { id: "drone", group: "pad" },
  { id: "air", group: "pad" },
  { id: "tom", group: "perc" },
];

export const SYNTH_IDS = SYNTHS.map((s) => s.id);
