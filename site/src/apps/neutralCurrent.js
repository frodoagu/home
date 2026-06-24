/* -------------------------------------------------------------------------
 * Cálculo de la corriente de neutro en un sistema trifásico (3F + N), aislado
 * de React para poder testearlo. El componente (NeutralCurrentVisualizer.jsx)
 * dibuja fasores/ondas a partir de este resultado.
 *
 * Dos modelos:
 *  - neutralCurrent({a,b,c}) — solo fundamental (compatibilidad / fasores).
 *  - harmonicNeutral(spectra) — espectro completo por fase. Las cargas no
 *    lineales (aires, fuentes conmutadas, LEDs…) inyectan armónicos. Los
 *    armónicos triples (3, 9, 15… = 3·impar) son de secuencia cero: están en
 *    fase en las tres fases y SE SUMAN en el neutro en vez de cancelarse, así
 *    que un sistema balanceado puede igual cargar fuerte el neutro.
 * ---------------------------------------------------------------------- */

export const I_MAX = 30; // A, fondo de escala por fase
export const F_HZ = 50; // red AR
export const T_MS = 1000 / F_HZ; // 20 ms

export const rad = (d) => (d * Math.PI) / 180;

// Ángulos fijos de cada fase (sistema balanceado en ángulo).
export const PHASE_ANGLES = { a: 0, b: 120, c: 240 };
export const PHASE_KEYS = ["a", "b", "c"];

// Órdenes de armónico que modelamos (impares; los pares no aparecen en cargas
// simétricas de media onda). Los triples (3, 9, 15) son los que cargan el neutro.
export const HARMONICS = [1, 3, 5, 7, 9, 11, 13];
export const isTriplen = (h) => h % 3 === 0;

/* -------------------------------------------------------------------------
 * Catálogo de artefactos. `current` = corriente fundamental (A) que toma el
 * artefacto; `spectrum` = magnitud de cada armónico como fracción de esa
 * fundamental (espectros ilustrativos, orden de magnitud realista). Cuanto
 * más "electrónica" la carga, más 3er armónico inyecta al neutro.
 * ---------------------------------------------------------------------- */
export const APPLIANCES = [
  {
    key: "aire",
    label: "Aire (inverter)",
    icon: "AirVent",
    current: 12,
    spectrum: { 3: 0.2, 5: 0.12, 7: 0.07, 9: 0.03 },
  },
  {
    key: "micro",
    label: "Microondas",
    icon: "Microwave",
    current: 8,
    spectrum: { 3: 0.3, 5: 0.18, 7: 0.08 },
  },
  {
    key: "bomba",
    label: "Bomba de agua",
    icon: "Droplets",
    current: 8,
    spectrum: { 3: 0.06, 5: 0.05, 7: 0.03 },
  },
  {
    key: "heladera",
    label: "Heladera",
    icon: "Refrigerator",
    current: 3,
    spectrum: { 3: 0.1, 5: 0.06, 7: 0.03 },
  },
  {
    key: "pc",
    label: "PC / Fuente",
    icon: "MonitorSmartphone",
    current: 2,
    spectrum: { 3: 0.6, 5: 0.35, 7: 0.2, 9: 0.1, 11: 0.06 },
  },
  {
    key: "led",
    label: "Luces LED",
    icon: "Lightbulb",
    current: 1.5,
    spectrum: { 3: 0.3, 5: 0.1, 7: 0.05 },
  },
];

export const getAppliance = (key) => APPLIANCES.find((a) => a.key === key);

/**
 * Corriente de neutro para módulos de fase {a, b, c} (en amperios), solo
 * fundamental. In = |Ia∠0 + Ib∠120 + Ic∠240| = √(Ia²+Ib²+Ic² − IaIb − IbIc − IcIa).
 * Devuelve la magnitud, las componentes cartesianas del fasor resultante, si
 * está balanceado y la severidad ("ok" | "warn" | "high").
 */
export function neutralCurrent({ a, b, c }) {
  const cx =
    a * Math.cos(rad(0)) + b * Math.cos(rad(120)) + c * Math.cos(rad(240));
  const cy =
    a * Math.sin(rad(0)) + b * Math.sin(rad(120)) + c * Math.sin(rad(240));
  // Radicando ≥0 analíticamente; clamp a 0 por error de float (-1e-15).
  const In = Math.sqrt(Math.max(0, a * a + b * b + c * c - a * b - b * c - c * a));
  const balanced = In < 0.2;
  let severity = "ok";
  if (!balanced) severity = "warn";
  if (In > I_MAX * 0.5) severity = "high"; // >15 A: neutro cargado
  return { In, comp: { x: cx, y: cy }, balanced, severity };
}

/**
 * Espectro de una fase = carga lineal base (solo fundamental) + artefactos.
 * Devuelve un mapa { orden: magnitud_A }. La fundamental del artefacto es su
 * `current`; cada armónico h aporta current · spectrum[h].
 */
export function buildPhaseSpectrum(base, appliances = []) {
  const spec = {};
  if (base) spec[1] = base;
  for (const a of appliances) {
    const cur = a.current ?? 0;
    spec[1] = (spec[1] ?? 0) + cur;
    for (const [h, frac] of Object.entries(a.spectrum ?? {})) {
      const ho = Number(h);
      spec[ho] = (spec[ho] ?? 0) + cur * frac;
    }
  }
  return spec;
}

/**
 * Corriente de neutro a partir del espectro por fase.
 * @param spectra { a: {orden: mag}, b: {...}, c: {...} }
 * Para cada armónico h se suman los tres fasores con ángulo h·(0/120/240)°;
 * la corriente de neutro total es el RMS de las resultantes por armónico:
 * In = √(Σ_h |In_h|²). Devuelve además el desglose por armónico (perHarmonic),
 * el fasor de la fundamental (comp, para el diagrama fasorial) y la fundamental
 * por fase (fund) para métricas.
 */
export function harmonicNeutral(spectra) {
  const orders = new Set();
  for (const k of PHASE_KEYS)
    for (const h of Object.keys(spectra[k] ?? {})) orders.add(Number(h));

  const perHarmonic = [];
  let sumSq = 0;
  let comp = { x: 0, y: 0 };

  for (const h of [...orders].sort((p, q) => p - q)) {
    let x = 0;
    let y = 0;
    for (const k of PHASE_KEYS) {
      const m = spectra[k]?.[h] ?? 0;
      const ang = rad(h * PHASE_ANGLES[k]);
      x += m * Math.cos(ang);
      y += m * Math.sin(ang);
    }
    const mag = Math.hypot(x, y);
    perHarmonic.push({ h, mag, triplen: isTriplen(h) });
    sumSq += mag * mag;
    if (h === 1) comp = { x, y };
  }

  const In = Math.sqrt(Math.max(0, sumSq));
  const fund = {
    a: spectra.a?.[1] ?? 0,
    b: spectra.b?.[1] ?? 0,
    c: spectra.c?.[1] ?? 0,
  };
  const balanced = In < 0.2;
  let severity = "ok";
  if (!balanced) severity = "warn";
  if (In > I_MAX * 0.5) severity = "high";

  return { In, comp, fund, perHarmonic, balanced, severity };
}

export const V_NOM = 230; // V fase-neutro (AR)

// Fallas combinables que se pueden simular (cortes de fase y/o de neutro).
export const FAULTS = [
  { key: "a", label: "Corte Fase A" },
  { key: "b", label: "Corte Fase B" },
  { key: "c", label: "Corte Fase C" },
  { key: "n", label: "Corte de Neutro" },
];

/** Multiplica todas las magnitudes de un espectro por un factor. */
export function scaleSpectrum(spec, f) {
  const out = {};
  for (const [h, m] of Object.entries(spec)) out[Number(h)] = m * f;
  return out;
}

/**
 * Neutro abierto (estrella flotante): las cargas quedan en estrella sin retorno,
 * así que la corriente de neutro es 0 y el punto estrella se desplaza. Tomando
 * cada carga como resistiva (conductancia G ∝ corriente fundamental), el neutro
 * flotante en pu es V_n = Σ Gₖ·∠θₖ / Σ Gₖ y la tensión sobre cada carga es
 * |∠θₖ − V_n|. Las fases poco cargadas suben (sobretensión) y las muy cargadas
 * bajan; con cargas balanceadas no hay desplazamiento.
 * @param fund { a, b, c } corrientes fundamentales por fase (A).
 * @returns { vn, V: {a,b,c} en V, ratio: {a,b,c} = V/V_NOM }
 */
export function openNeutralVoltages(fund) {
  const G = { a: fund.a || 0, b: fund.b || 0, c: fund.c || 0 };
  const Gsum = G.a + G.b + G.c;
  if (Gsum < 1e-9)
    return {
      vn: { x: 0, y: 0 },
      V: { a: V_NOM, b: V_NOM, c: V_NOM },
      ratio: { a: 1, b: 1, c: 1 },
    };
  let nx = 0;
  let ny = 0;
  for (const k of PHASE_KEYS) {
    nx += G[k] * Math.cos(rad(PHASE_ANGLES[k]));
    ny += G[k] * Math.sin(rad(PHASE_ANGLES[k]));
  }
  const vn = { x: nx / Gsum, y: ny / Gsum };
  const V = {};
  const ratio = {};
  for (const k of PHASE_KEYS) {
    const dx = Math.cos(rad(PHASE_ANGLES[k])) - vn.x;
    const dy = Math.sin(rad(PHASE_ANGLES[k])) - vn.y;
    const r = Math.hypot(dx, dy);
    ratio[k] = r;
    V[k] = r * V_NOM;
  }
  return { vn, V, ratio };
}

/** Corriente instantánea de una fase (suma de armónicos) en θ [rad]. */
export function phaseInstant(spec, angleDeg, theta) {
  let v = 0;
  for (const [h, mag] of Object.entries(spec)) {
    const ho = Number(h);
    v += mag * Math.sin(ho * theta + rad(ho * angleDeg));
  }
  return v;
}
