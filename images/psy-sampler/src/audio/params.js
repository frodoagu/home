// What the editors can change. Each spec is one slider: values are kept in the
// units the voice uses (Hz, seconds, bars) and `fmt` turns them into the label.
// The defaults here are the ones the voices fall back to; a variant can start
// from different values (patterns.js), but always within [min, max].

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const ms = (v) => `${Math.round(v * 1000)} ms`;
const sec = (v) => `${v.toFixed(1)} s`;
const pct = (v) => `${Math.round(v * 100)} %`;
const times = (v) => `×${v.toFixed(2)}`;
const bars = (v) => `${v} ${v === 1 ? "compás" : "compases"}`;

const tone = (def, min, max, label = "Tono") => ({ key: "tone", label, min, max, step: 10, def, fmt: hz });
const decay = (def, min, max, step = 0.005, fmt = ms) => ({ key: "decay", label: "Decay", min, max, step, def, fmt });
const length = (def) => ({ key: "bars", label: "Largo", min: 1, max: 4, step: 1, def, fmt: bars });

export const PARAMS = {
  /* drum voices */
  kick: [
    { key: "f0", label: "Tono inicial", min: 80, max: 260, step: 1, def: 170, fmt: hz },
    { key: "f1", label: "Tono final", min: 30, max: 90, step: 1, def: 50, fmt: hz },
    { key: "sweep", label: "Caída de tono", min: 0.02, max: 0.25, step: 0.005, def: 0.07, fmt: ms },
    decay(0.2, 0.06, 0.7),
    { key: "click", label: "Click", min: 0, max: 1, step: 0.05, def: 1, fmt: pct },
  ],
  hat: [tone(7000, 3000, 12000, "Corte HP"), decay(0.14, 0.03, 0.5)],
  chat: [tone(9000, 4000, 14000, "Corte HP"), decay(0.035, 0.015, 0.15)],
  shaker: [tone(6500, 2000, 10000, "Banda"), decay(0.045, 0.015, 0.2)],
  clap: [tone(1800, 800, 4000, "Banda"), decay(0.17, 0.06, 0.5)],
  snare: [tone(190, 120, 320), decay(0.15, 0.05, 0.4)],
  ride: [tone(9000, 5000, 12000, "Banda"), decay(0.45, 0.1, 1.2, 0.01)],

  /* every melodic synth */
  synth: [{ key: "bright", label: "Brillo", min: 0.25, max: 4, step: 0.05, def: 1, fmt: times }],

  /* one-shot FX */
  "fx.riser": [length(2), { key: "top", label: "Hasta", min: 2000, max: 15000, step: 100, def: 9000, fmt: hz }],
  "fx.riserImpact": [length(2)],
  "fx.down": [length(1), { key: "from", label: "Desde", min: 2000, max: 12000, step: 100, def: 8000, fmt: hz }],
  "fx.sweep": [length(1), { key: "top", label: "Pico", min: 1500, max: 12000, step: 100, def: 6000, fmt: hz }],
  "fx.impact": [
    { key: "f0", label: "Tono", min: 50, max: 160, step: 1, def: 90, fmt: hz },
    decay(1.5, 0.4, 3, 0.1, sec),
  ],
  "fx.zap": [
    { key: "f0", label: "Desde", min: 1000, max: 8000, step: 50, def: 4000, fmt: hz },
    decay(0.4, 0.1, 1, 0.01),
  ],
  "fx.crash": [tone(6000, 3000, 10000, "Corte HP"), decay(2, 0.5, 4, 0.1, sec)],
  "fx.siren": [length(1), { key: "rate", label: "Vibrato", min: 2, max: 12, step: 0.5, def: 7, fmt: (v) => `${v} Hz` }],
};

// Every variant, of any kind, also gets a volume relative to its layer's level.
export const LEVEL = { key: "level", label: "Volumen", min: 0, max: 1.5, step: 0.05, def: 1, fmt: pct };

export const paramDefaults = (specId) => Object.fromEntries((PARAMS[specId] ?? []).map((p) => [p.key, p.def]));

// Instruments a melodic variant can play through (voices.js INSTRUMENTS).
// The references are to Ableton devices whose basic patch each one imitates.
export const SYNTHS = [
  { id: "bass", group: "Bajos", label: "Saw pluck", detail: "saw + LP que se cierra en cada nota" },
  { id: "sub", group: "Bajos", label: "Sub", detail: "seno + triángulo una octava arriba" },
  { id: "fmBass", group: "Bajos", label: "FM bass", detail: "2 operadores, el índice cae: el «tok» psy (tipo Operator)" },
  { id: "reese", group: "Bajos", label: "Reese", detail: "2 saws desafinadas ±12 cents + sub" },
  { id: "acid", group: "Leads", label: "Acid 303", detail: "saw + LP resonante que deriva (tipo TB-303)" },
  { id: "supersaw", group: "Leads", label: "Supersaw", detail: "5 saws desafinadas (tipo Wavetable)" },
  { id: "analog", group: "Leads", label: "Analog", detail: "2 squares desafinadas + LP con envolvente (tipo Analog)" },
  { id: "pluck", group: "Leads", label: "Pluck", detail: "saw + square, el filtro se cierra rápido (tipo Drift)" },
  { id: "arp", group: "Leads", label: "Square", detail: "square percusiva, seca" },
  { id: "lead", group: "Leads", label: "Saw lead", detail: "saw sostenida con vibrato retardado" },
  { id: "fmBell", group: "Leads", label: "FM bell", detail: "campana FM, relación 3,5 (tipo Operator)" },
  { id: "zap", group: "Leads", label: "Zapper", detail: "cada nota cae desde 2 octavas arriba" },
  { id: "pad", group: "Pads", label: "Saw pad", detail: "2 saws ±7 cents, ataque lento" },
  { id: "drone", group: "Pads", label: "Drone", detail: "saws graves, LP resonante con LFO lento" },
  { id: "air", group: "Pads", label: "Viento", detail: "ruido filtrado afinado a la nota" },
  { id: "tom", group: "Percusión", label: "Tom", detail: "seno que cae: tom tribal afinado" },
];

export const SYNTH_IDS = SYNTHS.map((s) => s.id);
