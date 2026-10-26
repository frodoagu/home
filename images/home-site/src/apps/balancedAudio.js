/* -------------------------------------------------------------------------
 * Balanced vs unbalanced audio lines, kept apart from React so it can be
 * tested. Every conductor carries a linear mix of one signal and a few
 * interference waveforms, so the model returns COEFFICIENTS (volts per
 * normalized waveform); BalancedAudio.jsx turns them into plots and sound.
 *
 * Coupling:
 *  - electric (dimmer, phone): lands on every exposed conductor; a grounded
 *    shield drains most of it.
 *  - magnetic (hum): common to the whole cable, plus a differential part set
 *    by the loop area between the two conductors, which twisting collapses.
 *    A copper shield does nothing against it at 50 Hz.
 *  - ground loop: the ground potential difference between both ends, dropped
 *    along the shield. An unbalanced line has it in series with the signal;
 *    on a balanced line it is common to both legs.
 * A differential receiver keeps hot − cold. Common-mode noise only gets
 * through the legs' impedance mismatch (`imbalance`) and the receiver's CMRR.
 * ---------------------------------------------------------------------- */

const TAU = Math.PI * 2;

export const MAINS_HZ = 50;
export const TONE_HZ = 250;
export const VIZ_RATE = 24000;
export const WINDOW_S = 1 / MAINS_HZ;
export const VIZ_N = Math.round(VIZ_RATE * WINDOW_S);
export const LOOP_S = 4; // audio loop; every waveform completes whole periods in it
export const REF_LENGTH = 10; // m, the length the noise volts are quoted at
export const DBU_REF = 0.775; // V rms

export const SHIELD_PASS = 0.03; // electric pickup left with a grounded shield
export const LOOP_AREA = { coax: 0.15, parallel: 0.3, twisted: 0.01 }; // differential magnetic pickup

export const MODES = [
  {
    key: "unbalanced",
    connector: "TS",
    label: { es: "No balanceado", en: "Unbalanced", pt: "Não balanceado", fr: "Asymétrique" },
  },
  {
    key: "balanced",
    connector: "XLR",
    label: { es: "Balanceado", en: "Balanced", pt: "Balanceado", fr: "Symétrique" },
  },
  {
    key: "impedance",
    connector: "XLR",
    label: { es: "Balanceado por impedancia", en: "Impedance-balanced", pt: "Balanceado por impedância", fr: "Symétrique par impédance" },
  },
  {
    key: "mixed",
    connector: "TRS → TS",
    label: { es: "Balanceado → no balanceado", en: "Balanced → unbalanced", pt: "Balanceado → não balanceado", fr: "Symétrique → asymétrique" },
  },
];

export const isDifferential = (mode) => mode === "balanced" || mode === "impedance";
export const usesPair = (mode) => mode !== "unbalanced";

// Peak volts of a full-scale tone at each nominal level.
export const LEVELS = [
  { key: "mic", volts: 0.005, label: { es: "Micrófono", en: "Microphone", pt: "Microfone", fr: "Micro" } },
  { key: "instrument", volts: 0.3, label: { es: "Instrumento", en: "Instrument", pt: "Instrumento", fr: "Instrument" } },
  { key: "line", volts: 1.736, label: { es: "Línea +4 dBu", en: "Line +4 dBu", pt: "Linha +4 dBu", fr: "Ligne +4 dBu" } },
];

export const SIGNALS = [
  { key: "tone", label: { es: `Tono ${TONE_HZ} Hz`, en: `${TONE_HZ} Hz tone`, pt: `Tom ${TONE_HZ} Hz`, fr: `Son ${TONE_HZ} Hz` } },
  { key: "guitar", label: { es: "Guitarra", en: "Guitar", pt: "Violão", fr: "Guitare" } },
  { key: "silence", label: { es: "Silencio", en: "Silence", pt: "Silêncio", fr: "Silence" } },
];

// `volts`: peak pickup at 100 % on REF_LENGTH of cable (ground: the ground
// potential difference itself).
export const NOISES = [
  {
    key: "hum",
    coupling: "magnetic",
    volts: 0.01,
    color: "#f59e0b",
    label: { es: "Transformador (hum)", en: "Transformer (hum)", pt: "Transformador (hum)", fr: "Transformateur (ronflement)" },
  },
  {
    key: "dimmer",
    coupling: "electric",
    volts: 0.03,
    color: "#e879f9",
    label: { es: "Dimmer / fuente conmutada", en: "Dimmer / switch-mode PSU", pt: "Dimmer / fonte chaveada", fr: "Variateur / alim. à découpage" },
  },
  {
    key: "phone",
    coupling: "electric",
    volts: 0.01,
    color: "#38bdf8",
    label: { es: "Celular (GSM)", en: "Mobile phone (GSM)", pt: "Celular (GSM)", fr: "Téléphone (GSM)" },
  },
  {
    key: "ground",
    coupling: "ground",
    volts: 0.05,
    color: "#fb7185",
    label: { es: "Lazo de masa", en: "Ground loop", pt: "Loop de terra", fr: "Boucle de masse" },
  },
];

export const KEYS = ["signal", ...NOISES.map((n) => n.key)];

export const dbu = (peak) => 20 * Math.log10(peak / Math.SQRT2 / DBU_REF);
export const cmrrLeak = (cmrrDb) => 10 ** (-cmrrDb / 20);
// Share of the ground difference that drops along the shield (vs the mains earth).
export const shieldShare = (length) => length / (length + REF_LENGTH);

/* ---- waveforms, normalized to a peak near 1 ---- */

export function noiseWave(key, t) {
  switch (key) {
    case "hum":
      return (Math.sin(TAU * 50 * t) + 0.45 * Math.sin(TAU * 150 * t + 0.6) + 0.2 * Math.sin(TAU * 250 * t + 1.3)) / 1.45;
    case "ground":
      return (Math.sin(TAU * 50 * t + 1.9) + 0.3 * Math.sin(TAU * 150 * t + 2.4) + 0.12 * Math.sin(TAU * 350 * t)) / 1.3;
    case "dimmer": {
      // A triac firing at 90°: one ringing edge per half cycle, alternating sign.
      const half = 1 / (2 * MAINS_HZ);
      const k = Math.floor((t - half / 2) / half);
      const d = t - half / 2 - k * half;
      return (k % 2 ? -1 : 1) * Math.exp(-d / 0.0004) * Math.cos(TAU * 3000 * d);
    }
    case "phone": {
      // GSM TDMA: one 577 µs burst every 1/217 s, demodulated by whatever rectifies it.
      const period = 1 / 217;
      const d = t - Math.floor(t / period) * period;
      return (d < 577e-6 ? 1 : 0) - 577e-6 * 217;
    }
    default:
      return 0;
  }
}

// The phone only talks to the tower now and then: dit-dit-dit… diiit.
const PHONE_BURSTS = [[0.2, 0.5], [0.7, 1.0], [1.2, 1.5], [2.4, 3.3]];
export const phoneGate = (t) => {
  const x = ((t % LOOP_S) + LOOP_S) % LOOP_S;
  return PHONE_BURSTS.some(([a, b]) => x >= a && x < b) ? 1 : 0;
};

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARPEGGIO = [110, 164.81, 220, 261.63, 329.63, 261.63, 220, 164.81]; // A minor

// Karplus-Strong plucks, one every half second, tails wrapped so the loop is seamless.
function guitar(rate, seconds) {
  const out = new Float32Array(Math.round(rate * seconds));
  const rand = mulberry32(7);
  const step = seconds / ARPEGGIO.length;
  ARPEGGIO.forEach((freq, i) => {
    const n = Math.round(rate / freq);
    const buf = new Float32Array(n);
    let prev = 0;
    for (let j = 0; j < n; j++) {
      const r = rand() * 2 - 1;
      buf[j] = (r + prev) / 2;
      prev = r;
    }
    const start = Math.round(i * step * rate);
    const ring = Math.min(out.length, Math.round(rate * 2.5));
    let idx = 0;
    for (let j = 0; j < ring; j++) {
      const cur = buf[idx];
      const next = buf[(idx + 1) % n];
      out[(start + j) % out.length] += cur;
      buf[idx] = 0.996 * 0.5 * (cur + next);
      idx = (idx + 1) % n;
    }
  });
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak;
  return out;
}

const signalCache = new Map();

export function renderSignal(kind, rate, seconds = LOOP_S) {
  const id = `${kind}:${rate}:${seconds}`;
  if (signalCache.has(id)) return signalCache.get(id);
  let out;
  if (kind === "guitar") out = guitar(rate, seconds);
  else {
    out = new Float32Array(Math.round(rate * seconds));
    if (kind === "tone") for (let i = 0; i < out.length; i++) out[i] = Math.sin((TAU * TONE_HZ * i) / rate);
  }
  signalCache.set(id, out);
  return out;
}

const sampleNoise = (key, n) => new Float32Array(n).map((_, i) => noiseWave(key, i / VIZ_RATE));

export function renderNoise(key, rate, seconds = LOOP_S) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = noiseWave(key, t) * (key === "phone" ? phoneGate(t) : 1);
  }
  return out;
}

// One mains cycle of every waveform, for the plots. The guitar window sits
// where a few notes overlap.
const GUITAR_VIEW_S = 1.56;
export function vizWaves(signalKind) {
  const waves = {};
  if (signalKind === "guitar") {
    const from = Math.round(GUITAR_VIEW_S * VIZ_RATE);
    waves.signal = renderSignal("guitar", VIZ_RATE).slice(from, from + VIZ_N);
  } else {
    waves.signal = renderSignal(signalKind, VIZ_RATE, WINDOW_S);
  }
  for (const n of NOISES) waves[n.key] = sampleNoise(n.key, VIZ_N);
  return waves;
}

// Ten mains cycles: long enough for every noise to average out.
const STATS_S = 0.2;
let statsTable = null;
function stats() {
  if (statsTable) return statsTable;
  const waves = { signal: renderSignal("tone", VIZ_RATE, STATS_S) };
  for (const n of NOISES) waves[n.key] = sampleNoise(n.key, Math.round(VIZ_RATE * STATS_S));
  const rms = {};
  const peak = {};
  for (const k of KEYS) {
    let s = 0;
    let p = 0;
    for (const v of waves[k]) {
      s += v * v;
      p = Math.max(p, Math.abs(v));
    }
    rms[k] = Math.sqrt(s / waves[k].length);
    peak[k] = p;
  }
  statsTable = { waves, rms, peak };
  return statsTable;
}

export const waveRms = (key) => stats().rms[key];
export const wavePeak = (key) => stats().peak[key];

/* ---- the line ---- */

const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
const mix = (...terms) => {
  const out = zero();
  for (const [c, w] of terms) for (const k of KEYS) out[k] += c[k] * w;
  return out;
};

export const DEFAULTS = {
  mode: "unbalanced",
  level: 0.3,
  length: 10,
  shield: true,
  twisted: true,
  imbalance: 0.01,
  cmrr: 60,
  noise: { hum: 0.5, dimmer: 0.5, phone: 0, ground: 0.25 },
  faults: { coldOpen: false, swapped: false },
};

/* Coefficients of each leg at the receiver and of its output:
 *   hot, cold — what each conductor carries (cold is null on a TS line: its
 *               return is the shield itself)
 *   out       — what the input stage hands on
 *   ideal     — `out` with no noise at all */
export function lineModel(settings) {
  const s = { ...DEFAULTS, ...settings };
  const reach = s.length / REF_LENGTH;
  const loop = !usesPair(s.mode) ? LOOP_AREA.coax : s.twisted ? LOOP_AREA.twisted : LOOP_AREA.parallel;

  const common = zero(); // picked up alike by every conductor
  const diff = zero(); // picked up between the two conductors
  for (const n of NOISES) {
    const v = n.volts * (s.noise[n.key] ?? 0);
    if (n.coupling === "electric") common[n.key] = v * reach * (s.shield ? SHIELD_PASS : 1);
    else if (n.coupling === "magnetic") {
      common[n.key] = v * reach;
      diff[n.key] = v * reach * loop;
    } else common[n.key] = v * shieldShare(s.length);
  }

  if (!isDifferential(s.mode)) {
    // The return is grounded at the receiver: the electric pickup on it drains
    // away and the magnetic common part cancels against it, so only the
    // differential magnetic part and the ground drop stay with the signal.
    const hot = zero();
    for (const n of NOISES) hot[n.key] = n.coupling === "magnetic" ? diff[n.key] : common[n.key];
    hot.signal = s.level;
    return { hot, cold: s.mode === "mixed" ? zero() : null, out: hot, ideal: { ...zero(), signal: s.level } };
  }

  const imb = s.imbalance / 2;
  const hot = mix([common, 1 + imb], [diff, 0.5]);
  let cold = mix([common, 1 - imb], [diff, -0.5]);
  hot.signal = s.level;
  cold.signal = s.mode === "balanced" ? -s.level : 0;
  if (s.faults.coldOpen) cold = zero(); // the receiver's input resistor holds it at ground

  const leak = cmrrLeak(s.cmrr);
  let out = mix([hot, 1 + leak / 2], [cold, -1 + leak / 2]);
  if (s.faults.swapped) out = mix([out, -1]);
  const ideal = { ...zero(), signal: out.signal };
  return { hot, cold, out, ideal };
}

/* ---- what comes out ---- */

export function trace(coefs, waves) {
  const n = waves.signal.length;
  const out = new Float32Array(n);
  for (const k of KEYS) {
    const c = coefs[k];
    if (!c) continue;
    const w = waves[k];
    for (let i = 0; i < n; i++) out[i] += c * w[i];
  }
  return out;
}

export function noiseRms(coefs) {
  const { waves } = stats();
  const noise = trace({ ...coefs, signal: 0 }, waves);
  let s = 0;
  for (const v of noise) s += v * v;
  return Math.sqrt(s / noise.length);
}

// Signal-to-noise of a full-scale tone at the selected level, in dB.
export function snrDb(out) {
  const n = noiseRms(out);
  const sig = Math.abs(out.signal) * waveRms("signal");
  if (sig === 0) return -Infinity;
  if (n === 0) return Infinity;
  return 20 * Math.log10(sig / n);
}

/* Monitor gains for listening: a preamp brings the signal to full scale and
 * everything else rides up with it, so what you hear is the SNR. If the sum
 * could clip, the whole mix comes down together. */
export function monitorGains(out) {
  const pre = out.signal ? 1 / Math.abs(out.signal) : 0;
  const gains = {};
  let total = 0;
  for (const k of KEYS) {
    gains[k] = out[k] * pre;
    total += Math.abs(gains[k]) * wavePeak(k);
  }
  const scale = total > 1 ? 1 / total : 1;
  for (const k of KEYS) gains[k] *= scale;
  return gains;
}
