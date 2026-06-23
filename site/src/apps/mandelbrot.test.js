import { describe, it, expect } from "vitest";
import {
  INITIAL_SPAN,
  MIN_SPAN,
  MAX_SPAN,
  INTERIOR,
  PALETTES,
  PRESETS,
  clamp,
  escapeCount,
  paletteCss,
  paletteGradient,
  computeRows,
  zoomView,
  panView,
} from "./mandelbrot";

describe("clamp", () => {
  it("limita al rango", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("escapeCount", () => {
  it("devuelve null para puntos del interior (0,0 nunca escapa)", () => {
    expect(escapeCount(0, 0, 500)).toBeNull();
  });

  it("devuelve null en el centro del bulbo izquierdo (-1, 0)", () => {
    expect(escapeCount(-1, 0, 500)).toBeNull();
  });

  it("escapa rápido para puntos lejanos al conjunto", () => {
    const mu = escapeCount(2, 2, 500);
    expect(mu).not.toBeNull();
    expect(mu).toBeGreaterThan(0);
    expect(mu).toBeLessThan(5);
  });

  it("da un valor continuo (no entero) por el coloreado suave", () => {
    const mu = escapeCount(0.4, 0.4, 500);
    expect(mu).not.toBeNull();
    expect(Number.isInteger(mu)).toBe(false);
  });
});

describe("paletteCss", () => {
  it("devuelve componentes RGB válidos (0–255) para todas las paletas", () => {
    for (const p of PALETTES) {
      for (const t of [0, 0.25, 0.5, 0.75, 1, 3.7]) {
        const parts = paletteCss(p, t).split(",").map(Number);
        expect(parts).toHaveLength(3);
        for (const c of parts) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
          expect(Number.isInteger(c)).toBe(true);
        }
      }
    }
  });
});

describe("paletteGradient", () => {
  it("arma un linear-gradient con 9 stops", () => {
    const g = paletteGradient(PALETTES[0]);
    expect(g.startsWith("linear-gradient(90deg,")).toBe(true);
    expect(g.match(/rgb\(/g)).toHaveLength(9);
  });
});

describe("computeRows", () => {
  it("rellena RGBA con alpha 255 y sin NaN", () => {
    const w = 16, h = 12;
    const data = new Uint8ClampedArray(w * h * 4);
    computeRows(data, w, h, -0.5, 0, INITIAL_SPAN, 200, PALETTES[0], 0, h);
    for (let i = 0; i < data.length; i += 4) {
      expect(Number.isNaN(data[i])).toBe(false);
      expect(data[i + 3]).toBe(255); // alpha
    }
  });

  it("pinta el interior con el color INTERIOR (el centro cae dentro)", () => {
    const w = 3, h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    // span chico centrado en (-0.5,0): todos los puntos caen en el conjunto.
    computeRows(data, w, h, -0.5, 0, 0.01, 300, PALETTES[0], 0, h);
    const o = (1 * w + 1) * 4; // píxel central
    expect([data[o], data[o + 1], data[o + 2]]).toEqual(INTERIOR);
  });

  it("sólo escribe el rango de filas pedido", () => {
    const w = 4, h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    computeRows(data, w, h, -0.5, 0, INITIAL_SPAN, 100, PALETTES[0], 2, 4);
    // Las filas 0–1 quedan en cero (alpha 0); las 2–3 escritas (alpha 255).
    expect(data[3]).toBe(0);
    expect(data[2 * w * 4 + 3]).toBe(255);
  });
});

describe("zoomView", () => {
  it("preserva siempre span (regresión del bug de pantalla negra)", () => {
    const v = { cx: -0.5, cy: 0, span: INITIAL_SPAN };
    const out = zoomView(v, 0.5, 0.5, 0.75, 0.5);
    expect(out.span).toBeDefined();
    expect(Number.isNaN(out.span)).toBe(false);
    expect(out.cx).toBeDefined();
    expect(out.cy).toBeDefined();
  });

  it("acerca con factor < 1 y aleja con factor > 1", () => {
    const v = { cx: -0.5, cy: 0, span: 2 }; // dentro de [MIN_SPAN, MAX_SPAN]
    expect(zoomView(v, 0.5, 0.5, 1, 0.5).span).toBeCloseTo(1);
    expect(zoomView(v, 0.5, 0.5, 1, 2).span).toBeCloseTo(4);
  });

  it("mantiene fijo el centro al hacer zoom centrado", () => {
    const v = { cx: -0.5, cy: 0.1, span: 3.2 };
    const out = zoomView(v, 0.5, 0.5, 0.75, 0.5);
    expect(out.cx).toBeCloseTo(-0.5);
    expect(out.cy).toBeCloseTo(0.1);
  });

  it("respeta los límites MIN_SPAN y MAX_SPAN", () => {
    const tiny = { cx: 0, cy: 0, span: MIN_SPAN };
    expect(zoomView(tiny, 0.5, 0.5, 1, 0.5).span).toBe(MIN_SPAN);
    const huge = { cx: 0, cy: 0, span: MAX_SPAN };
    expect(zoomView(huge, 0.5, 0.5, 1, 2).span).toBe(MAX_SPAN);
  });
});

describe("panView", () => {
  it("preserva span y desplaza el centro", () => {
    const v = { cx: -0.5, cy: 0, span: 3.2 };
    const out = panView(v, 0.25, 0, 0.75);
    expect(out.span).toBe(3.2);
    expect(out.cx).toBeCloseTo(-0.5 - 0.25 * 3.2);
    expect(out.cy).toBeCloseTo(0);
  });
});

describe("PRESETS", () => {
  it("todos tienen cx, cy, span (>0) e iter dentro del rango del slider", () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const p of PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(Number.isFinite(p.cx)).toBe(true);
      expect(Number.isFinite(p.cy)).toBe(true);
      expect(p.span).toBeGreaterThan(0);
      expect(p.iter).toBeGreaterThanOrEqual(50);
      expect(p.iter).toBeLessThanOrEqual(1200);
    }
  });
});
