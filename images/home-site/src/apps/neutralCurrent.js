/* -------------------------------------------------------------------------
 * Cálculo de la corriente de neutro en un sistema trifásico (3F + N), aislado
 * de React para poder testearlo. El componente (NeutralCurrentVisualizer.jsx)
 * dibuja fasores/ondas a partir de este resultado.
 *
 * Dos modelos:
 *  - neutralCurrent({a,b,c}) — solo fundamental (compatibilidad / fasores).
 *  - harmonicNeutral(spectra, phi) — espectro completo por fase. Las cargas no
 *    lineales (aires, fuentes conmutadas, LEDs…) inyectan armónicos. Los
 *    armónicos triples (3, 9, 15… = 3·impar) son de secuencia cero: están en
 *    fase en las tres fases y SE SUMAN en el neutro en vez de cancelarse, así
 *    que un sistema balanceado puede igual cargar fuerte el neutro.
 *
 * La fundamental es un FASOR: cada carga tiene un desplazamiento φ entre
 * tensión y corriente (inductivo = atrasa, capacitivo = adelanta), así que dos
 * cargas de la misma corriente pueden sumar menos que la suma aritmética. Eso
 * es lo que hace `buildPhaseLoad`, y de ahí salen el triángulo de potencias
 * (`phasePower` / `systemPower`) y la corrección con capacitores.
 * ---------------------------------------------------------------------- */

export const I_MAX = 100; // A, fondo de escala por fase
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
 * artefacto en MARCHA/régimen; `spectrum` = magnitud de cada armónico como
 * fracción de esa fundamental. Valores aproximados a 230 V fase-neutro (AR),
 * con I ≈ P / 230. El pico de arranque de los motores (4-6× la nominal) NO se
 * modela acá: el catálogo representa el consumo en régimen permanente.
 *
 * `pf` + `kind` describen la parte REACTIVA: `pf` es el factor de potencia de
 * desplazamiento (cos φ) y `kind` su signo — "ind" la corriente atrasa (todo
 * lo que tenga bobinado: motores, balastos, transformadores), "cap" adelanta
 * (drivers capacitivos, capacitores) y "res" es carga óhmica pura.
 *
 * Regla práctica de la firma armónica:
 *  - Cargas resistivas (resistencias, boilers): casi senoidales, ~0 armónicos.
 *  - Motores de inducción (bombas, compresores): poca distorsión, algo de 5ª/7ª.
 *  - Fuentes conmutadas / electrónica (PC, TV, LED): mucho 3er armónico, que es
 *    el que SE SUMA en el neutro (triple) aunque las fases estén balanceadas.
 *
 * Ojo con confundir las dos cosas: una fuente conmutada tiene cos φ ≈ 1 (la
 * corriente no está corrida) y sin embargo un factor de potencia REAL malísimo,
 * porque lo que sobra es distorsión, no reactiva. Un capacitor no la arregla.
 * ---------------------------------------------------------------------- */
export const APPLIANCES = [
  {
    // Split inverter ~4000 frig a plena carga: ~1.4 kW eléctricos (EER ~3.2).
    // El variador tiene corrección activa, así que casi no desplaza.
    key: "aire",
    label: { es: "Aire (inverter)", en: "AC (inverter)" },
    icon: "AirVent",
    current: 6,
    pf: 0.95,
    kind: "ind",
    spectrum: { 3: 0.2, 5: 0.12, 7: 0.07, 9: 0.03 },
  },
  {
    // Magnetrón ~1000 W de salida ≈ 1.5 kW de entrada. Doblador media onda
    // sobre un transformador con fuga -> muy inductivo Y muy distorsionado.
    key: "micro",
    label: { es: "Microondas", en: "Microwave" },
    icon: "Microwave",
    current: 6.5,
    pf: 0.65,
    kind: "ind",
    spectrum: { 3: 0.3, 5: 0.18, 7: 0.08 },
  },
  {
    // Cafetera automática 2000 W: el boiler/resistencia domina -> carga casi
    // lineal (mucha corriente, poco aporte al neutro). La distorsión chica es
    // por la bomba vibratoria y el control electrónico.
    key: "cafetera",
    label: { es: "Cafetera (2000 W)", en: "Coffee maker (2000 W)" },
    icon: "Coffee",
    current: 8.7,
    pf: 1,
    kind: "res",
    spectrum: { 3: 0.05, 5: 0.03 },
  },
  {
    // Compresor 1/2 HP (~0.37 kW mec.): motor de inducción a plena carga,
    // ~1 kW de entrada en marcha. Arranque (LRA) 4-6× la nominal, no modelado.
    key: "compresor",
    label: { es: "Compresor (½ HP)", en: "Compressor (½ HP)" },
    icon: "Wind",
    current: 4.5,
    pf: 0.8,
    kind: "ind",
    spectrum: { 3: 0.05, 5: 0.06, 7: 0.04 },
  },
  {
    // Bomba de agua 1/2 HP en marcha (~0.69 kW de entrada). Motor de inducción.
    key: "bomba",
    label: { es: "Bomba de agua", en: "Water pump" },
    icon: "Droplets",
    current: 3,
    pf: 0.82,
    kind: "ind",
    spectrum: { 3: 0.06, 5: 0.05, 7: 0.03 },
  },
  {
    // Heladera no-frost: compresor en marcha ~0.28 kW (el ciclo de defrost
    // suma más, pero el catálogo modela el compresor en régimen). Motor chico
    // = cos φ pobre.
    key: "heladera",
    label: { es: "Heladera", en: "Fridge" },
    icon: "Refrigerator",
    current: 1.2,
    pf: 0.75,
    kind: "ind",
    spectrum: { 3: 0.1, 5: 0.06, 7: 0.03 },
  },
  {
    // Motor de inducción girando en vacío: casi no entrega potencia activa
    // pero la magnetización sigue ahí -> el caso de libro de reactiva pura.
    key: "motor",
    label: { es: "Motor en vacio", en: "Idle motor" },
    icon: "Fan",
    current: 3.5,
    pf: 0.35,
    kind: "ind",
    spectrum: { 5: 0.05, 7: 0.03 },
  },
  {
    // Tubo fluorescente con balasto electromagnético (sin capacitor de
    // compensación): el balasto es una inductancia en serie.
    key: "tubo",
    label: { es: "Tubo fluorescente", en: "Fluorescent tube" },
    icon: "Lamp",
    current: 0.9,
    pf: 0.5,
    kind: "ind",
    spectrum: { 3: 0.15, 5: 0.08 },
  },
  {
    // TV LED/OLED grande ~160 W. Fuente conmutada -> fuerte 3er armónico.
    key: "tele",
    label: { es: "Televisores", en: "TVs" },
    icon: "Tv",
    current: 0.7,
    pf: 0.95,
    kind: "ind",
    spectrum: { 3: 0.45, 5: 0.25, 7: 0.12, 9: 0.06 },
  },
  {
    // Fuente sin PFC: el pico de corriente cae junto al pico de tensión, así
    // que cos φ ≈ 1; lo que arruina el factor de potencia real es la distorsión.
    key: "pc",
    label: { es: "PC / Fuente", en: "PC / PSU" },
    icon: "MonitorSmartphone",
    current: 2,
    pf: 0.99,
    kind: "ind",
    spectrum: { 3: 0.6, 5: 0.35, 7: 0.2, 9: 0.1, 11: 0.06 },
  },
  {
    // Lámpara LED barata con fuente capacitiva (capacitive dropper): la
    // corriente ADELANTA. Es el artefacto capacitivo típico de una casa.
    key: "led",
    label: { es: "Luces LED", en: "LED lights" },
    icon: "Lightbulb",
    current: 1,
    pf: 0.55,
    kind: "cap",
    spectrum: { 3: 0.3, 5: 0.1, 7: 0.05 },
  },
  {
    // Capacitor de 20 µF a 230 V/50 Hz: I = V·2πfC ≈ 1.45 A, reactiva pura
    // adelantada (φ = −90°). Sirve para compensar a mano, artefacto por
    // artefacto, en vez de con el banco.
    key: "capacitor",
    label: { es: "Capacitor 20 uF", en: "20 uF capacitor" },
    icon: "CircuitBoard",
    current: 1.45,
    pf: 0,
    kind: "cap",
  },
];

/**
 * Ángulo de desplazamiento φ (rad) entre tensión y corriente de una carga.
 * Positivo = la corriente ATRASA (inductivo), negativo = adelanta (capacitivo).
 */
export function displacementAngle({ pf = 1, kind = "res" } = {}) {
  if (kind !== "ind" && kind !== "cap") return 0;
  const phi = Math.acos(Math.min(1, Math.max(0, pf)));
  return kind === "cap" ? -phi : phi;
}

/* ---- aritmética compleja mínima; los fasores son {re, im} ---- */
const cAdd = (p, q) => ({ re: p.re + q.re, im: p.im + q.im });
const cMul = (p, q) => ({ re: p.re * q.re - p.im * q.im, im: p.re * q.im + p.im * q.re });
const cDiv = (p, q) => {
  const d = q.re * q.re + q.im * q.im;
  if (d < 1e-30) return { re: 0, im: 0 };
  return { re: (p.re * q.re + p.im * q.im) / d, im: (p.im * q.re - p.re * q.im) / d };
};
const cAbs = (p) => Math.hypot(p.re, p.im);
const toC = (v) => (typeof v === "number" ? { re: v, im: 0 } : { re: v?.re ?? 0, im: v?.im ?? 0 });
const unit = (deg) => ({ re: Math.cos(rad(deg)), im: Math.sin(rad(deg)) });

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
 * Carga de una fase = carga lineal base (resistiva) + artefactos + banco de
 * capacitores. La fundamental se suma como FASOR — cada artefacto aporta
 * I∠−φ tomando la tensión de esa fase como referencia — así que lo inductivo y
 * lo capacitivo se compensan entre sí y el módulo resultante puede ser menor
 * que la suma aritmética. Los armónicos, en cambio, se suman en módulo.
 *
 * @param base A de carga lineal resistiva (φ = 0).
 * @param appliances artefactos del catálogo (usan `current`, `pf`, `kind`, `spectrum`).
 * @param capKvar kVAr capacitivos conectados a ESTA fase (banco de corrección).
 * @returns {{spec, phi, fund, load, cap, qLoad}} `spec` = { orden: magnitud_A }
 *   con spec[1] = módulo del fasor resultante; `phi` = desplazamiento resultante
 *   (rad, >0 atrasa); `load` = fasor de la carga SIN el banco; `cap` = A del
 *   banco; `qLoad` = reactiva de la carga sin compensar (var).
 */
export function buildPhaseLoad(base, appliances = [], capKvar = 0) {
  const spec = {};
  let re = base || 0;
  let im = 0;
  for (const a of appliances) {
    const cur = a?.current ?? 0;
    const ph = displacementAngle(a ?? {});
    re += cur * Math.cos(ph);
    im -= cur * Math.sin(ph); // atrasar = parte imaginaria negativa
    for (const [h, frac] of Object.entries(a?.spectrum ?? {})) {
      const ho = Number(h);
      spec[ho] = (spec[ho] ?? 0) + cur * frac;
    }
  }
  const cap = capacitorCurrent(capKvar);
  const total = { re, im: im + cap };
  const fund = cAbs(total);
  if (fund > 0) spec[1] = fund;
  return {
    spec,
    phi: fund > 0 ? -Math.atan2(total.im, total.re) : 0,
    fund,
    load: { re, im },
    cap,
    qLoad: -V_NOM * im,
  };
}

/** Espectro por fase en módulos (atajo de `buildPhaseLoad` para los fasores). */
export function buildPhaseSpectrum(base, appliances = []) {
  return buildPhaseLoad(base, appliances).spec;
}

/**
 * Corriente de neutro a partir del espectro por fase.
 * @param spectra { a: {orden: mag}, b: {...}, c: {...} }
 * @param phi { a, b, c } desplazamiento de la fundamental de cada fase (rad,
 *   >0 atrasa). Sólo corre la fundamental: los armónicos se dejan en h·θ.
 * Para cada armónico h se suman los tres fasores con ángulo h·(0/120/240)°;
 * la corriente de neutro total es el RMS de las resultantes por armónico:
 * In = √(Σ_h |In_h|²). Devuelve además el desglose por armónico (perHarmonic),
 * el fasor de la fundamental (comp, para el diagrama fasorial) y la fundamental
 * por fase (fund) para métricas.
 */
export function harmonicNeutral(spectra, phi = {}) {
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
      const ang = h === 1
        ? rad(PHASE_ANGLES[k]) - (phi[k] || 0)
        : rad(h * PHASE_ANGLES[k]);
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
  { key: "a", label: { es: "Corte Fase A", en: "Phase A open" } },
  { key: "b", label: { es: "Corte Fase B", en: "Phase B open" } },
  { key: "c", label: { es: "Corte Fase C", en: "Phase C open" } },
  { key: "n", label: { es: "Corte de Neutro", en: "Neutral open" } },
];

/** Multiplica todas las magnitudes de un espectro por un factor. */
export function scaleSpectrum(spec, f) {
  const out = {};
  for (const [h, m] of Object.entries(spec)) out[Number(h)] = m * f;
  return out;
}

/**
 * Neutro abierto (estrella flotante): las cargas quedan en estrella sin retorno,
 * así que la corriente de neutro es 0 y el punto estrella se desplaza. Cada
 * carga es una admitancia Yₖ ∝ Iₖ∠−φₖ, y el neutro flotante en pu es
 * V_n = Σ Yₖ·∠θₖ / Σ Yₖ; la tensión sobre cada carga es |∠θₖ − V_n|. Las fases
 * poco cargadas suben (sobretensión) y las muy cargadas bajan; con cargas
 * balanceadas no hay desplazamiento aunque sean reactivas.
 * @param fund { a, b, c } corrientes fundamentales por fase (A).
 * @param phi { a, b, c } desplazamiento de cada fase (rad, >0 atrasa).
 * @returns { vn, V: {a,b,c} en V, ratio: {a,b,c} = V/V_NOM }
 */
export function openNeutralVoltages(fund, phi = {}) {
  const Y = {};
  let ysum = { re: 0, im: 0 };
  for (const k of PHASE_KEYS) {
    const m = fund[k] || 0;
    const p = phi[k] || 0;
    Y[k] = { re: m * Math.cos(p), im: -m * Math.sin(p) };
    ysum = cAdd(ysum, Y[k]);
  }
  if (cAbs(ysum) < 1e-9)
    return {
      vn: { x: 0, y: 0 },
      V: { a: V_NOM, b: V_NOM, c: V_NOM },
      ratio: { a: 1, b: 1, c: 1 },
    };
  let num = { re: 0, im: 0 };
  for (const k of PHASE_KEYS) num = cAdd(num, cMul(Y[k], unit(PHASE_ANGLES[k])));
  const n = cDiv(num, ysum);
  const vn = { x: n.re, y: n.im };
  const V = {};
  const ratio = {};
  for (const k of PHASE_KEYS) {
    const e = unit(PHASE_ANGLES[k]);
    const r = cAbs({ re: e.re - vn.x, im: e.im - vn.y });
    ratio[k] = r;
    V[k] = r * V_NOM;
  }
  return { vn, V, ratio };
}

// Resistividad del cobre (Ω·mm²/m) a ~20 °C.
export const RHO_CU = 0.0175;
// Secciones de cable normalizadas (mm²).
export const CABLE_SECTIONS = [1.5, 2.5, 4, 6, 10, 16, 25, 35];

/** Resistencia de un conductor: R = ρ·L/A (L en m, A en mm²). */
export function cableResistance(lengthM, sectionMm2) {
  if (!sectionMm2 || sectionMm2 <= 0) return Infinity;
  return (RHO_CU * (lengthM || 0)) / sectionMm2;
}

/**
 * Tensión fase-neutro en la carga, a frecuencia fundamental, resolviendo el
 * nodo del neutro con la resistencia de cada cable. Modela en un solo cálculo:
 *  - la caída de tensión por la carga (más amperes -> más caída),
 *  - el desplazamiento del neutro por su propia resistencia,
 *  - el neutro abierto (Rn = Infinity), donde el punto estrella flota.
 *
 * Cargas como admitancia Y_p (S), compleja: Y = (I/V)∠−φ, así que una carga
 * inductiva atrasa su corriente y una capacitiva la adelanta. Cada fase ve
 * E_p = V_NOM∠θ_p en el origen y un cable R_p; el neutro vuelve por R_n. Con
 * a_p = Y_p/(1+Y_p·R_p):
 *   V_N = Σ E_p·a_p / (Σ a_p + 1/R_n)
 *   I_p = (E_p − V_N)·a_p ,  U_carga_p = (E_p − V_N)/(1 + Y_p·R_p)
 *
 * @param {{G:{a,b,c}, R:{a,b,c}, Rn:number}} p — G acepta un número (carga
 *   resistiva) o un fasor {re, im} de admitancia.
 * @returns {{V:{a,b,c} (V), ang:{a,b,c} (rad), I:{a,b,c} (A), vn:{x,y}, In:number}}
 */
export function solveVoltages({ G, R, Rn }) {
  const Y = {};
  const a = {};
  const one = { re: 1, im: 0 };
  for (const k of PHASE_KEYS) {
    Y[k] = toC(G[k] ?? 0);
    const Rp = R[k] || 0;
    // Cable abierto (R = ∞): esa fase no conduce.
    a[k] = Number.isFinite(Rp)
      ? cDiv(Y[k], cAdd(one, cMul(Y[k], { re: Rp, im: 0 })))
      : { re: 0, im: 0 };
  }
  const E = {};
  for (const k of PHASE_KEYS) {
    const u = unit(PHASE_ANGLES[k]);
    E[k] = { re: V_NOM * u.re, im: V_NOM * u.im };
  }

  let num = { re: 0, im: 0 };
  let den = Number.isFinite(Rn) && Rn > 0 ? { re: 1 / Rn, im: 0 } : { re: 0, im: 0 };
  for (const k of PHASE_KEYS) {
    num = cAdd(num, cMul(E[k], a[k]));
    den = cAdd(den, a[k]);
  }
  const n = cAbs(den) > 1e-12 ? cDiv(num, den) : { re: 0, im: 0 };
  const vn = { x: n.re, y: n.im };

  const V = {};
  const ang = {};
  const I = {};
  let inC = { re: 0, im: 0 };
  for (const k of PHASE_KEYS) {
    const d = { re: E[k].re - vn.x, im: E[k].im - vn.y };
    const ip = cMul(d, a[k]);
    inC = cAdd(inC, ip);
    I[k] = cAbs(ip);
    const Rp = R[k] || 0;
    const u = Number.isFinite(Rp)
      ? cDiv(d, cAdd(one, cMul(Y[k], { re: Rp, im: 0 })))
      : { re: 0, im: 0 };
    V[k] = cAbs(u);
    ang[k] = Math.atan2(u.im, u.re);
  }
  return { V, ang, I, vn, In: cAbs(inC) };
}

// Ampacidad orientativa (A) por sección (mm²) — cobre, aislación PVC.
export const AMPACITY = {
  1.5: 17.5, 2.5: 24, 4: 32, 6: 41, 10: 57, 16: 76, 25: 101, 35: 125,
};
export const T_AMBIENT = 30; // °C de referencia
export const T_RATED_RISE = 40; // °C de elevación a la ampacidad (PVC 70 °C)
export const ALPHA_CU = 0.00393; // 1/°C, coef. térmico del cobre (ref. 20 °C)

/** Resistencia del cobre corregida por temperatura: R(T) = R₂₀·(1 + α·(T−20)). */
export function resistanceAtTemp(r20, tempC) {
  if (!Number.isFinite(r20)) return r20;
  return r20 * (1 + ALPHA_CU * (tempC - 20));
}

/** Corriente eficaz (RMS) de un espectro: √(Σ mₕ²). */
export function specRms(spec) {
  let s = 0;
  for (const m of Object.values(spec || {})) s += m * m;
  return Math.sqrt(s);
}

/**
 * Temperatura estimada del conductor en régimen permanente. El calentamiento
 * es ∝ I² (efecto Joule) y la disipación ∝ ΔT, así que en equilibrio
 * ΔT ∝ (I/I_ampacidad)². A la ampacidad el conductor llega a su temperatura
 * nominal (T_AMBIENT + T_RATED_RISE). Sube al aumentar I y al bajar la sección.
 */
export function conductorTemp(irms, sectionMm2, ambient = T_AMBIENT) {
  const amp = AMPACITY[sectionMm2];
  if (!amp || !irms) return ambient;
  return ambient + T_RATED_RISE * (irms / amp) ** 2;
}

/**
 * Corriente instantánea de una fase (suma de armónicos) en θ [rad]. `phi`
 * atrasa la fundamental: es lo que se ve como corrimiento contra la tensión.
 */
export function phaseInstant(spec, angleDeg, theta, phi = 0) {
  let v = 0;
  for (const [h, mag] of Object.entries(spec)) {
    const ho = Number(h);
    const shift = ho === 1 ? phi : 0;
    v += mag * Math.sin(ho * theta + rad(ho * angleDeg) - shift);
  }
  return v;
}

/* -------------------------------------------------------------------------
 * Triángulo de potencias. Con distorsión armónica no alcanza con el cos φ: la
 * corriente que no está a 50 Hz no transporta potencia activa pero igual
 * calienta el cable, así que el factor de potencia REAL (P/S) queda por debajo
 * del de desplazamiento. Esa diferencia es la potencia de distorsión D, y el
 * triángulo se vuelve un tetraedro: S² = P² + Q² + D².
 * ---------------------------------------------------------------------- */

/** Corriente (A) de un banco de `kvar` capacitivos en una fase a V_NOM. */
export const capacitorCurrent = (kvar) => ((kvar || 0) * 1000) / V_NOM;

/** cos φ objetivo habitual para no pagar recargo por reactiva. */
export const PF_TARGET = 0.95;

/**
 * Potencias de una fase (W / var / VA). Q > 0 es inductiva (atrasada).
 * @param spec espectro { orden: A } de la fase.
 * @param phi desplazamiento de la fundamental (rad).
 * @param v tensión de fase (V).
 */
export function phasePower(spec, phi = 0, v = V_NOM) {
  const i1 = spec?.[1] ?? 0;
  const irms = specRms(spec);
  const P = v * i1 * Math.cos(phi);
  const Q = v * i1 * Math.sin(phi);
  const D = v * Math.sqrt(Math.max(0, irms * irms - i1 * i1));
  const S = v * irms;
  return {
    P, Q, D, S, i1, irms, phi,
    cosPhi: i1 > 1e-9 ? Math.cos(phi) : 1,
    pf: S > 1e-9 ? P / S : 1,
  };
}

/**
 * Suma trifásica. P y Q se suman algebraicamente (lo inductivo de una fase
 * compensa lo capacitivo de otra); la aparente es la suma aritmética de las
 * fases — el criterio usual con desbalance — y la distorsión cierra el
 * tetraedro: D = √(S² − P² − Q²).
 */
export function systemPower(perPhase) {
  let P = 0;
  let Q = 0;
  let S = 0;
  for (const ph of perPhase) {
    P += ph.P;
    Q += ph.Q;
    S += ph.S;
  }
  const S1 = Math.hypot(P, Q);
  return {
    P, Q, S, S1,
    D: Math.sqrt(Math.max(0, S * S - P * P - Q * Q)),
    phi: Math.atan2(Q, P),
    cosPhi: S1 > 1e-9 ? P / S1 : 1,
    pf: S > 1e-9 ? P / S : 1,
  };
}

/**
 * kVAr capacitivos que hay que agregar para llevar una carga (P, Q en W/var) a
 * `targetPf` atrasado: Q_c = P·(tan φ − tan φ_objetivo). Devuelve 0 si la carga
 * ya está adelantada (un capacitor la empeoraría).
 */
export function kvarToCorrect(P, Q, targetPf = PF_TARGET) {
  const t = Math.min(0.999, Math.max(0.05, targetPf));
  return Math.max(0, (Q - P * Math.tan(Math.acos(t))) / 1000);
}
