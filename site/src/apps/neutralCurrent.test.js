import { describe, it, expect } from "vitest";
import { neutralCurrent, rad, T_MS, I_MAX } from "./neutralCurrent";

describe("rad", () => {
  it("convierte grados a radianes", () => {
    expect(rad(180)).toBeCloseTo(Math.PI);
    expect(rad(0)).toBe(0);
  });
});

describe("constantes", () => {
  it("T_MS es 20 ms (50 Hz) e I_MAX 30 A", () => {
    expect(T_MS).toBe(20);
    expect(I_MAX).toBe(30);
  });
});

describe("neutralCurrent", () => {
  it("sistema balanceado: In ≈ 0 y severity ok", () => {
    const r = neutralCurrent({ a: 10, b: 10, c: 10 });
    expect(r.In).toBeCloseTo(0);
    expect(r.balanced).toBe(true);
    expect(r.severity).toBe("ok");
  });

  it("monofásico 30/0/0: In = 30 y severity high", () => {
    const r = neutralCurrent({ a: 30, b: 0, c: 0 });
    expect(r.In).toBeCloseTo(30);
    expect(r.severity).toBe("high");
    expect(r.balanced).toBe(false);
  });

  it("desbalance leve 10/7/7: 0 < In < 15 y severity warn", () => {
    const r = neutralCurrent({ a: 10, b: 7, c: 7 });
    expect(r.In).toBeGreaterThan(0);
    expect(r.In).toBeLessThan(I_MAX * 0.5);
    expect(r.severity).toBe("warn");
  });

  it("nunca devuelve NaN aunque el radicando sea ~0 por float", () => {
    const r = neutralCurrent({ a: 10, b: 10, c: 10 });
    expect(Number.isNaN(r.In)).toBe(false);
    expect(r.In).toBeGreaterThanOrEqual(0);
  });

  it("coincide con la fórmula fasorial √(Σ I² − Σ IxIy)", () => {
    const { a, b, c } = { a: 12, b: 5, c: 3 };
    const expected = Math.sqrt(a * a + b * b + c * c - a * b - b * c - c * a);
    expect(neutralCurrent({ a, b, c }).In).toBeCloseTo(expected);
  });
});
