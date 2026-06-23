/* -------------------------------------------------------------------------
 * Cálculo de la corriente de neutro en un sistema trifásico (3F + N), aislado
 * de React para poder testearlo. El componente (NeutralCurrentVisualizer.jsx)
 * dibuja fasores/ondas a partir de este resultado.
 * ---------------------------------------------------------------------- */

export const I_MAX = 30; // A, fondo de escala por fase
export const F_HZ = 50; // red AR
export const T_MS = 1000 / F_HZ; // 20 ms

export const rad = (d) => (d * Math.PI) / 180;

// Ángulos fijos de cada fase (sistema balanceado en ángulo).
export const PHASE_ANGLES = { a: 0, b: 120, c: 240 };

/**
 * Corriente de neutro para módulos de fase {a, b, c} (en amperios).
 * In = |Ia∠0 + Ib∠120 + Ic∠240| = √(Ia²+Ib²+Ic² − IaIb − IbIc − IcIa).
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
