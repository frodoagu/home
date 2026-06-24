import { describe, it, expect } from "vitest";
import {
  neutralCurrent, rad, T_MS, I_MAX,
  buildPhaseSpectrum, harmonicNeutral, getAppliance, isTriplen,
  openNeutralVoltages, scaleSpectrum, V_NOM,
  cableResistance, solveVoltages, RHO_CU,
} from "./neutralCurrent";

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

describe("isTriplen", () => {
  it("marca 3, 9, 15 como triples y 1, 5, 7 como no", () => {
    expect([3, 9, 15].every(isTriplen)).toBe(true);
    expect([1, 5, 7, 11, 13].some(isTriplen)).toBe(false);
  });
});

describe("buildPhaseSpectrum", () => {
  it("solo carga base: espectro = { 1: base }", () => {
    expect(buildPhaseSpectrum(10, [])).toEqual({ 1: 10 });
  });

  it("suma fundamental de artefactos y proyecta sus armónicos", () => {
    const ac = { current: 10, spectrum: { 3: 0.2, 5: 0.1 } };
    const spec = buildPhaseSpectrum(5, [ac]);
    expect(spec[1]).toBeCloseTo(15); // base 5 + fundamental 10
    expect(spec[3]).toBeCloseTo(2);  // 10 · 0.2
    expect(spec[5]).toBeCloseTo(1);  // 10 · 0.1
  });
});

describe("harmonicNeutral", () => {
  it("fundamental balanceada sin armónicos: In ≈ 0", () => {
    const s = { a: { 1: 10 }, b: { 1: 10 }, c: { 1: 10 } };
    const r = harmonicNeutral(s);
    expect(r.In).toBeCloseTo(0);
    expect(r.severity).toBe("ok");
    expect(r.fund).toEqual({ a: 10, b: 10, c: 10 });
  });

  it("armónico triple balanceado se SUMA en el neutro (3× por fase)", () => {
    // 3ª armónica de 4 A en cada fase: en fase entre sí -> In = 12 A
    const s = { a: { 3: 4 }, b: { 3: 4 }, c: { 3: 4 } };
    const r = harmonicNeutral(s);
    expect(r.In).toBeCloseTo(12); // fases "balanceadas" pero el neutro conduce 12 A
    expect(r.severity).toBe("warn");
    const h3 = r.perHarmonic.find((p) => p.h === 3);
    expect(h3.mag).toBeCloseTo(12);
    expect(h3.triplen).toBe(true);
  });

  it("armónico NO triple (5ª) balanceado se cancela en el neutro", () => {
    const s = { a: { 5: 4 }, b: { 5: 4 }, c: { 5: 4 } };
    expect(harmonicNeutral(s).In).toBeCloseTo(0);
  });

  it("RMS sobre armónicos: In = √(Σ |In_h|²)", () => {
    // fundamental desbalanceada (5/0/0 -> 5) + 3ª balanceada (3 c/u -> 9)
    const s = { a: { 1: 5, 3: 3 }, b: { 3: 3 }, c: { 3: 3 } };
    const r = harmonicNeutral(s);
    expect(r.In).toBeCloseTo(Math.hypot(5, 9));
    expect(r.severity).toBe("warn");
  });

  it("corte de fase = espectro vacío: el neutro conduce el resto", () => {
    const s = { a: {}, b: { 1: 8 }, c: { 1: 8 } };
    const r = harmonicNeutral(s);
    // dos fases iguales a 120°+240° => |8∠120 + 8∠240| = 8 A
    expect(r.In).toBeCloseTo(8);
    expect(r.fund.a).toBe(0);
  });
});

describe("scaleSpectrum", () => {
  it("escala todas las magnitudes y normaliza claves a número", () => {
    expect(scaleSpectrum({ 1: 10, 3: 2 }, 0.5)).toEqual({ 1: 5, 3: 1 });
  });
});

describe("openNeutralVoltages", () => {
  it("cargas balanceadas: sin desplazamiento, tensión nominal", () => {
    const r = openNeutralVoltages({ a: 10, b: 10, c: 10 });
    expect(r.vn.x).toBeCloseTo(0);
    expect(r.vn.y).toBeCloseTo(0);
    for (const k of ["a", "b", "c"]) {
      expect(r.ratio[k]).toBeCloseTo(1);
      expect(r.V[k]).toBeCloseTo(V_NOM);
    }
  });

  it("sin carga: tensión nominal en las tres fases", () => {
    const r = openNeutralVoltages({ a: 0, b: 0, c: 0 });
    expect(r.V).toEqual({ a: V_NOM, b: V_NOM, c: V_NOM });
  });

  it("monofásico 10/0/0: la fase cargada cae y las vacías suben a √3·Vnom", () => {
    const r = openNeutralVoltages({ a: 10, b: 0, c: 0 });
    expect(r.ratio.a).toBeCloseTo(0);
    expect(r.ratio.b).toBeCloseTo(Math.sqrt(3));
    expect(r.ratio.c).toBeCloseTo(Math.sqrt(3));
  });

  it("desbalance: la fase muy cargada se hunde y la poco cargada sobretensiona", () => {
    const r = openNeutralVoltages({ a: 10, b: 1, c: 1 });
    expect(r.ratio.a).toBeLessThan(1); // subtensión
    expect(r.ratio.b).toBeGreaterThan(1); // sobretensión
    expect(r.ratio.c).toBeGreaterThan(1);
  });
});

describe("cableResistance", () => {
  it("R = ρ·L/A", () => {
    expect(cableResistance(20, 4)).toBeCloseTo((RHO_CU * 20) / 4);
  });
  it("sección 0 o inválida => Infinity (conductor abierto)", () => {
    expect(cableResistance(20, 0)).toBe(Infinity);
  });
});

describe("solveVoltages", () => {
  const Z = { a: 0, b: 0, c: 0 };

  it("sin carga: tensión nominal en las tres fases", () => {
    const r = solveVoltages({ G: Z, R: Z, Rn: 0.1 });
    for (const k of ["a", "b", "c"]) expect(r.V[k]).toBeCloseTo(V_NOM);
  });

  it("balanceado con cable ideal (R=0): sin caída ni corrimiento", () => {
    const g = 0.05;
    const r = solveVoltages({ G: { a: g, b: g, c: g }, R: Z, Rn: 0.01 });
    for (const k of ["a", "b", "c"]) expect(r.V[k]).toBeCloseTo(V_NOM);
    expect(r.In).toBeCloseTo(0);
  });

  it("caída de tensión: más carga en una fase => menos tensión en esa carga", () => {
    const R = { a: 0.5, b: 0.5, c: 0.5 };
    const light = solveVoltages({ G: { a: 0.02, b: 0, c: 0 }, R, Rn: 0.01 });
    const heavy = solveVoltages({ G: { a: 0.2, b: 0, c: 0 }, R, Rn: 0.01 });
    expect(heavy.V.a).toBeLessThan(light.V.a);
    expect(heavy.V.a).toBeLessThan(V_NOM);
    expect(heavy.I.a).toBeGreaterThan(light.I.a); // pero más corriente
  });

  it("neutro abierto (Rn=∞) coincide con openNeutralVoltages cuando R=0", () => {
    const G = { a: 10 / V_NOM, b: 1 / V_NOM, c: 1 / V_NOM };
    const sv = solveVoltages({ G, R: Z, Rn: Infinity });
    const ov = openNeutralVoltages({ a: 10, b: 1, c: 1 });
    for (const k of ["a", "b", "c"]) expect(sv.V[k]).toBeCloseTo(ov.V[k]);
    expect(sv.In).toBeCloseTo(0); // sin retorno, no hay corriente de neutro
  });

  it("neutro abierto monofásico: la fase vacía sobretensiona", () => {
    const r = solveVoltages({ G: { a: 0.05, b: 0, c: 0 }, R: Z, Rn: Infinity });
    expect(r.V.b).toBeGreaterThan(V_NOM);
    expect(r.V.c).toBeGreaterThan(V_NOM);
  });
});

describe("harmonicNeutral (extra)", () => {
  it("aires balanceados en las 3 fases cargan el neutro vía 3ª", () => {
    const ac = getAppliance("aire");
    const spec = buildPhaseSpectrum(0, [ac]);
    const r = harmonicNeutral({ a: spec, b: spec, c: spec });
    // fundamental se cancela; suman los triples: 3ª (2.4/fase) y 9ª (0.36/fase)
    expect(r.In).toBeCloseTo(Math.hypot(2.4 * 3, 0.36 * 3), 2);
    expect(r.fund).toEqual({ a: 12, b: 12, c: 12 }); // fundamental balanceada
  });
});
