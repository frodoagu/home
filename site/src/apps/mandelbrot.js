/* -------------------------------------------------------------------------
 * Núcleo matemático del explorador de Mandelbrot — sin React ni canvas, para
 * poder testearlo de forma aislada. El componente (MandelbrotExplorer.jsx) sólo
 * orquesta el render y la interacción usando estas piezas.
 * ---------------------------------------------------------------------- */

export const TAU = Math.PI * 2;
export const INITIAL_SPAN = 3.2; // ancho del plano complejo en la vista completa
export const MIN_SPAN = 4e-14; // límite práctico del double (más allá: pixelado)
export const MAX_SPAN = 4.5;
export const ESCAPE2 = 1 << 16; // |z|² de escape (256²) — radio grande = degradé suave
export const COLOR_CYCLE = 0.028; // iteraciones por ciclo de color ≈ 1/COLOR_CYCLE
export const MAX_INTERNAL = 2048; // tope del lado mayor del canvas (en píxeles reales);
// el render ocurre en el navegador del cliente, no en el Pi — alto = nítido.
export const PREVIEW_MAX = 380; // lado mayor del preview (px) — fijo para que el
// arrastre/zoom sea fluido sin importar la resolución del render completo.
export const INTERIOR = [8, 10, 20]; // color del interior del conjunto

// Paletas (a, b, c, d) del esquema coseno de IQ. Vibrantes a propósito.
export const PALETTES = [
  { name: "Arcoíris", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.33, 0.67] },
  { name: "Fuego", a: [0.5, 0.45, 0.4], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.1, 0.2] },
  { name: "Océano", a: [0.4, 0.5, 0.5], b: [0.45, 0.5, 0.5], c: [1, 1, 1], d: [0.6, 0.55, 0.4] },
  { name: "Neón", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2.0, 1.0, 0.0], d: [0.5, 0.2, 0.25] },
  { name: "Áureo", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.3, 0.2, 0.2] },
];

// Lugares emblemáticos del fractal. span chico = más zoom; iter sube en lo profundo.
export const PRESETS = [
  { label: "Vista completa", cx: -0.5, cy: 0, span: 3.2, iter: 200 },
  { label: "Valle de caballitos", cx: -0.745428, cy: 0.113009, span: 0.016, iter: 600 },
  { label: "Valle de elefantes", cx: 0.2925, cy: 0.0149, span: 0.05, iter: 500 },
  { label: "Espiral triple", cx: -0.088, cy: 0.654, span: 0.028, iter: 600 },
  { label: "Mini-Mandelbrot", cx: -1.768778, cy: 0.001738, span: 0.006, iter: 800 },
  { label: "Tentáculos", cx: -0.748, cy: 0.1, span: 0.0017, iter: 900 },
  { label: "Espiral satélite", cx: -0.722, cy: 0.246, span: 0.018, iter: 700 },
  { label: "Misiurewicz", cx: -0.77568377, cy: 0.13646737, span: 0.012, iter: 800 },
];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Nueva vista tras un zoom de factor `factor` (<1 acerca, >1 aleja) que mantiene
 * fijo el punto bajo el cursor, dado en fracciones (fx, fy) ∈ [0,1] del lienzo y
 * el aspecto (alto/ancho). Devuelve SIEMPRE {cx, cy, span} — no perder `span`.
 */
export function zoomView(view, fx, fy, aspect, factor) {
  const reAt = view.cx + (fx - 0.5) * view.span;
  const imAt = view.cy + (fy - 0.5) * view.span * aspect;
  const span = clamp(view.span * factor, MIN_SPAN, MAX_SPAN);
  return {
    cx: reAt - (fx - 0.5) * span,
    cy: imAt - (fy - 0.5) * span * aspect,
    span,
  };
}

/**
 * Dimensiones de exportación que conservan el aspecto del lienzo (cw×ch) y ponen
 * el lado mayor en `long` px (4K = 3840 por defecto). Devuelve {W, H} enteros.
 */
export function exportDims(cw, ch, long = 3840) {
  if (cw <= 0 || ch <= 0) return { W: long, H: long };
  return cw >= ch
    ? { W: long, H: Math.max(1, Math.round((long * ch) / cw)) }
    : { W: Math.max(1, Math.round((long * cw) / ch)), H: long };
}

/**
 * Nueva vista tras desplazar el lienzo (fdx, fdy) en fracciones del ancho/alto.
 * Conserva `span`.
 */
export function panView(view, fdx, fdy, aspect) {
  return {
    cx: view.cx - fdx * view.span,
    cy: view.cy - fdy * view.span * aspect,
    span: view.span,
  };
}

// Iteraciones de escape para el punto c = (re, im). Devuelve la iteración
// normalizada (continua) si escapa, o `null` si pertenece al conjunto.
export function escapeCount(re, im, maxIter) {
  let zx = 0, zy = 0, zx2 = 0, zy2 = 0, n = 0;
  while (n < maxIter && zx2 + zy2 <= ESCAPE2) {
    zy = 2 * zx * zy + im;
    zx = zx2 - zy2 + re;
    zx2 = zx * zx;
    zy2 = zy * zy;
    n++;
  }
  if (n >= maxIter) return null; // interior del conjunto
  const invLn2 = 1 / Math.LN2;
  const logZn = Math.log(zx2 + zy2) * 0.5;
  const nu = Math.log(logZn * invLn2) * invLn2;
  return n + 1 - nu;
}

// Color "r,g,b" (0–255) de un punto continuo `t` para una paleta.
export function paletteCss(p, t) {
  const ch = (i) =>
    clamp(Math.round(255 * (p.a[i] + p.b[i] * Math.cos(TAU * (p.c[i] * t + p.d[i])))), 0, 255);
  return `${ch(0)},${ch(1)},${ch(2)}`;
}

// Gradiente CSS de muestra para una paleta (un ciclo de color).
export function paletteGradient(p) {
  const stops = [];
  for (let i = 0; i <= 8; i++) stops.push(`rgb(${paletteCss(p, i / 8)}) ${(i / 8) * 100}%`);
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

// Rellena `data` (RGBA) para las filas [rowStart, rowEnd). Paleta inlineada para
// no asignar objetos por píxel en el loop caliente.
export function computeRows(data, rw, rh, cx, cy, span, maxIter, p, rowStart, rowEnd) {
  const dx = span / rw; // píxeles cuadrados → mismo paso en x e y
  const x0 = cx - span / 2 + dx / 2;
  const y0 = cy - (dx * rh) / 2 + dx / 2;
  const [a0, a1, a2] = p.a, [b0, b1, b2] = p.b, [c0, c1, c2] = p.c, [d0, d1, d2] = p.d;
  for (let py = rowStart; py < rowEnd; py++) {
    const im = y0 + py * dx;
    let o = py * rw * 4;
    for (let px = 0; px < rw; px++) {
      const re = x0 + px * dx;
      const mu = escapeCount(re, im, maxIter);
      if (mu === null) {
        data[o++] = INTERIOR[0]; data[o++] = INTERIOR[1]; data[o++] = INTERIOR[2]; data[o++] = 255;
      } else {
        const t = mu * COLOR_CYCLE;
        data[o++] = clamp((a0 + b0 * Math.cos(TAU * (c0 * t + d0))) * 255, 0, 255);
        data[o++] = clamp((a1 + b1 * Math.cos(TAU * (c1 * t + d1))) * 255, 0, 255);
        data[o++] = clamp((a2 + b2 * Math.cos(TAU * (c2 * t + d2))) * 255, 0, 255);
        data[o++] = 255;
      }
    }
  }
}
