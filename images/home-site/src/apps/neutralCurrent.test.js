import { describe, it, expect } from "vitest";
import {
  neutralCurrent, rad, T_MS, I_MAX,
  buildPhaseSpectrum, harmonicNeutral, getAppliance, isTriplen,
  openNeutralVoltages, scaleSpectrum, V_NOM,
  cableResistance, solveVoltages, RHO_CU,
  conductorTemp, specRms, AMPACITY, T_AMBIENT, T_RATED_RISE,
  resistanceAtTemp, ALPHA_CU,
  displacementAngle, buildPhaseLoad, capacitorCurrent,
  phasePower, systemPower, kvarToCorrect, PF_TARGET, phaseInstant,
} from "./neutralCurrent";

describe("rad", () => {
  it("convierte grados a radianes", () => {
    expect(rad(180)).toBeCloseTo(Math.PI);
    expect(rad(0)).toBe(0);
  });
});

describe("constantes", () => {
  it("T_MS es 20 ms (50 Hz) e I_MAX 100 A", () => {
    expect(T_MS).toBe(20);
    expect(I_MAX).toBe(100);
  });
});

describe("neutralCurrent", () => {
  it("sistema balanceado: In ≈ 0 y severity ok", () => {
    const r = neutralCurrent({ a: 10, b: 10, c: 10 });
    expect(r.In).toBeCloseTo(0);
    expect(r.balanced).toBe(true);
    expect(r.severity).toBe("ok");
  });

  it("monofásico 100/0/0: In = 100 y severity high", () => {
    const r = neutralCurrent({ a: 100, b: 0, c: 0 });
    expect(r.In).toBeCloseTo(100);
    expect(r.severity).toBe("high");
    expect(r.balanced).toBe(false);
  });

  it("desbalance leve 10/7/7: 0 < In < I_MAX/2 y severity warn", () => {
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

describe("specRms", () => {
  it("RMS = √(Σ mₕ²)", () => {
    expect(specRms({ 1: 3, 3: 4 })).toBeCloseTo(5);
    expect(specRms({})).toBe(0);
  });
});

describe("conductorTemp", () => {
  it("sin corriente: queda en ambiente", () => {
    expect(conductorTemp(0, 4)).toBe(T_AMBIENT);
  });
  it("a la ampacidad llega a la temperatura nominal", () => {
    expect(conductorTemp(AMPACITY[4], 4)).toBeCloseTo(T_AMBIENT + T_RATED_RISE);
  });
  it("sube con la corriente (∝ I²)", () => {
    const t1 = conductorTemp(10, 4);
    const t2 = conductorTemp(20, 4);
    expect(t2 - T_AMBIENT).toBeCloseTo(4 * (t1 - T_AMBIENT)); // doble I => 4× elevación
  });
  it("sube al bajar la sección (misma corriente)", () => {
    expect(conductorTemp(20, 2.5)).toBeGreaterThan(conductorTemp(20, 6));
  });
});

describe("resistanceAtTemp", () => {
  it("a 20 °C no cambia", () => {
    expect(resistanceAtTemp(0.1, 20)).toBeCloseTo(0.1);
  });
  it("caliente => más resistencia (y por ende más caída)", () => {
    expect(resistanceAtTemp(0.1, 70)).toBeCloseTo(0.1 * (1 + ALPHA_CU * 50));
    expect(resistanceAtTemp(0.1, 70)).toBeGreaterThan(0.1);
  });
  it("Infinity (conductor abierto) se mantiene", () => {
    expect(resistanceAtTemp(Infinity, 80)).toBe(Infinity);
  });
});

describe("harmonicNeutral (extra)", () => {
  it("aires balanceados en las 3 fases cargan el neutro vía 3ª", () => {
    const ac = getAppliance("aire");
    const spec = buildPhaseSpectrum(0, [ac]);
    const r = harmonicNeutral({ a: spec, b: spec, c: spec });
    // fundamental se cancela; suman los triples (3ª y 9ª), 3 fases en fase.
    const i3 = ac.current * (ac.spectrum[3] ?? 0);
    const i9 = ac.current * (ac.spectrum[9] ?? 0);
    expect(r.In).toBeCloseTo(Math.hypot(i3 * 3, i9 * 3), 2);
    for (const k of ["a", "b", "c"]) expect(r.fund[k]).toBeCloseTo(ac.current); // balanceada
  });
});

describe("displacementAngle", () => {
  it("resistiva pura: φ = 0", () => {
    expect(displacementAngle({ pf: 1, kind: "res" })).toBe(0);
    expect(displacementAngle({})).toBe(0);
  });

  it("inductiva atrasa (φ > 0) y capacitiva adelanta (φ < 0)", () => {
    expect(displacementAngle({ pf: 0.8, kind: "ind" })).toBeCloseTo(Math.acos(0.8));
    expect(displacementAngle({ pf: 0.8, kind: "cap" })).toBeCloseTo(-Math.acos(0.8));
  });

  it("pf 0 = reactiva pura (±90°)", () => {
    expect(displacementAngle({ pf: 0, kind: "cap" })).toBeCloseTo(-Math.PI / 2);
  });

  it("el catálogo trae motores inductivos y LEDs capacitivos", () => {
    expect(displacementAngle(getAppliance("motor"))).toBeGreaterThan(0);
    expect(displacementAngle(getAppliance("led"))).toBeLessThan(0);
    expect(displacementAngle(getAppliance("cafetera"))).toBe(0);
  });
});

describe("buildPhaseLoad", () => {
  it("carga resistiva: suma aritmética y sin desplazamiento", () => {
    const r = buildPhaseLoad(10, [getAppliance("cafetera")]);
    expect(r.fund).toBeCloseTo(10 + getAppliance("cafetera").current);
    expect(r.phi).toBeCloseTo(0);
    expect(r.qLoad).toBeCloseTo(0);
  });

  it("inductivo + capacitivo suman MENOS que la suma aritmética", () => {
    const ind = { current: 5, pf: 0, kind: "ind" };
    const cap = { current: 3, pf: 0, kind: "cap" };
    const r = buildPhaseLoad(0, [ind, cap]);
    expect(r.fund).toBeCloseTo(2); // reactivas puras opuestas: 5 − 3
    expect(r.phi).toBeCloseTo(Math.PI / 2); // queda inductiva
  });

  it("una carga inductiva pide reactiva (qLoad > 0)", () => {
    const r = buildPhaseLoad(0, [getAppliance("motor")]);
    expect(r.qLoad).toBeGreaterThan(0);
    expect(r.phi).toBeGreaterThan(0);
  });

  it("el banco de capacitores baja la corriente sin tocar la activa", () => {
    const apps = [getAppliance("motor")];
    const sin = buildPhaseLoad(0, apps);
    const con = buildPhaseLoad(0, apps, sin.qLoad / 1000); // compensación total
    expect(con.fund).toBeLessThan(sin.fund);
    expect(con.phi).toBeCloseTo(0, 3); // cos φ = 1
    // la componente activa (la que hace trabajo) no cambia
    expect(con.fund * Math.cos(con.phi)).toBeCloseTo(sin.fund * Math.cos(sin.phi));
  });

  it("sobrecompensar da vuelta el signo: queda capacitiva", () => {
    const apps = [getAppliance("motor")];
    const q = buildPhaseLoad(0, apps).qLoad / 1000;
    const r = buildPhaseLoad(0, apps, q * 2);
    expect(r.phi).toBeLessThan(0);
  });

  it("los armónicos se suman en módulo, no como fasor", () => {
    const a = { current: 10, pf: 0.5, kind: "ind", spectrum: { 3: 0.2 } };
    const b = { current: 10, pf: 0.5, kind: "cap", spectrum: { 3: 0.2 } };
    const r = buildPhaseLoad(0, [a, b]);
    expect(r.spec[3]).toBeCloseTo(4); // 2 + 2, aunque las fundamentales se corran
    expect(r.fund).toBeLessThan(20);
  });

  it("sin carga no inventa fundamental", () => {
    expect(buildPhaseLoad(0, []).spec).toEqual({});
  });
});

describe("capacitorCurrent", () => {
  it("I = kVAr·1000 / V", () => {
    expect(capacitorCurrent(2.3)).toBeCloseTo(2300 / V_NOM);
    expect(capacitorCurrent(0)).toBe(0);
  });
});

describe("harmonicNeutral con desplazamiento", () => {
  it("mismo φ en las tres fases sigue balanceado", () => {
    const s = { a: { 1: 10 }, b: { 1: 10 }, c: { 1: 10 } };
    const phi = { a: 0.6, b: 0.6, c: 0.6 };
    expect(harmonicNeutral(s, phi).In).toBeCloseTo(0);
  });

  it("mismos módulos pero distinto φ: el neutro conduce", () => {
    // tres fases de 10 A, una inductiva y las otras resistivas
    const s = { a: { 1: 10 }, b: { 1: 10 }, c: { 1: 10 } };
    const r = harmonicNeutral(s, { a: Math.PI / 3, b: 0, c: 0 });
    expect(r.In).toBeGreaterThan(1);
    expect(r.severity).toBe("warn");
  });

  it("el desplazamiento no toca los armónicos", () => {
    const s = { a: { 3: 4 }, b: { 3: 4 }, c: { 3: 4 } };
    expect(harmonicNeutral(s, { a: 1, b: 0.2, c: -0.5 }).In).toBeCloseTo(12);
  });
});

describe("phasePower", () => {
  it("resistiva pura: toda la potencia es activa", () => {
    const r = phasePower({ 1: 10 }, 0);
    expect(r.P).toBeCloseTo(V_NOM * 10);
    expect(r.Q).toBeCloseTo(0);
    expect(r.pf).toBeCloseTo(1);
  });

  it("inductiva: Q > 0 y P = V·I·cos φ", () => {
    const phi = Math.acos(0.8);
    const r = phasePower({ 1: 10 }, phi);
    expect(r.P).toBeCloseTo(V_NOM * 10 * 0.8);
    expect(r.Q).toBeGreaterThan(0);
    expect(r.cosPhi).toBeCloseTo(0.8);
  });

  it("capacitiva: Q < 0", () => {
    expect(phasePower({ 1: 10 }, -Math.acos(0.8)).Q).toBeLessThan(0);
  });

  it("con armónicos el factor de potencia real cae por debajo del cos φ", () => {
    const r = phasePower({ 1: 10, 3: 6 }, 0);
    expect(r.cosPhi).toBeCloseTo(1); // no hay desplazamiento
    expect(r.pf).toBeLessThan(0.9);  // pero el PF real es malo: es distorsión
    expect(r.D).toBeGreaterThan(0);
  });

  it("cierra el tetraedro S² = P² + Q² + D²", () => {
    const r = phasePower({ 1: 10, 3: 4, 5: 2 }, 0.5);
    expect(r.S * r.S).toBeCloseTo(r.P * r.P + r.Q * r.Q + r.D * r.D, 4);
  });

  it("sin carga no divide por cero", () => {
    const r = phasePower({}, 0);
    expect(r.pf).toBe(1);
    expect(r.S).toBe(0);
  });
});

describe("systemPower", () => {
  it("tres fases iguales: potencias por 3", () => {
    const ph = phasePower({ 1: 10 }, Math.acos(0.8));
    const t = systemPower([ph, ph, ph]);
    expect(t.P).toBeCloseTo(3 * ph.P);
    expect(t.cosPhi).toBeCloseTo(0.8);
  });

  it("una fase inductiva y otra capacitiva se compensan en Q", () => {
    const phi = Math.acos(0.8);
    const t = systemPower([phasePower({ 1: 10 }, phi), phasePower({ 1: 10 }, -phi)]);
    expect(t.Q).toBeCloseTo(0);
    expect(t.P).toBeGreaterThan(0);
  });

  it("sin carga: cos φ y PF valen 1", () => {
    const t = systemPower([phasePower({}, 0)]);
    expect(t.cosPhi).toBe(1);
    expect(t.pf).toBe(1);
  });
});

describe("kvarToCorrect", () => {
  it("los kVAr calculados llevan el cos φ al objetivo", () => {
    const phi = Math.acos(0.7);
    const p = phasePower({ 1: 20 }, phi);
    const q = kvarToCorrect(p.P, p.Q, PF_TARGET);
    const after = buildPhaseLoad(0, [{ current: 20, pf: 0.7, kind: "ind" }], q);
    expect(Math.cos(after.phi)).toBeCloseTo(PF_TARGET, 3);
  });

  it("carga ya capacitiva: no hay nada que compensar", () => {
    const p = phasePower({ 1: 10 }, -0.5);
    expect(kvarToCorrect(p.P, p.Q)).toBe(0);
  });
});

describe("solveVoltages con carga reactiva", () => {
  const R = { a: 0.3, b: 0.3, c: 0.3 };
  const Y = (i, phi) => ({ re: (i / V_NOM) * Math.cos(phi), im: -(i / V_NOM) * Math.sin(phi) });

  it("balanceada aunque sea inductiva: el neutro no conduce", () => {
    const y = Y(20, Math.acos(0.7));
    const r = solveVoltages({ G: { a: y, b: y, c: y }, R, Rn: 0.3 });
    expect(r.In).toBeCloseTo(0);
    for (const k of ["a", "b", "c"]) expect(r.V[k]).toBeCloseTo(r.V.a);
  });

  it("misma corriente reactiva pura cae menos que resistiva (caída ≈ R·I·cos φ)", () => {
    const res = solveVoltages({ G: { a: Y(30, 0), b: 0, c: 0 }, R, Rn: 0.3 });
    const ind = solveVoltages({ G: { a: Y(30, Math.PI / 2), b: 0, c: 0 }, R, Rn: 0.3 });
    expect(res.V.a).toBeLessThan(ind.V.a);
    expect(ind.V.a).toBeLessThan(V_NOM);
  });

  it("dos fases con el mismo módulo pero distinto φ cargan el neutro", () => {
    const r = solveVoltages({
      G: { a: Y(20, Math.acos(0.5)), b: Y(20, 0), c: Y(20, 0) },
      R, Rn: 0.3,
    });
    expect(r.In).toBeGreaterThan(1);
  });
});

describe("openNeutralVoltages con desplazamiento", () => {
  it("cargas reactivas pero balanceadas: no se desplaza la estrella", () => {
    const r = openNeutralVoltages({ a: 10, b: 10, c: 10 }, { a: 0.7, b: 0.7, c: 0.7 });
    expect(r.vn.x).toBeCloseTo(0);
    expect(r.vn.y).toBeCloseTo(0);
    for (const k of ["a", "b", "c"]) expect(r.V[k]).toBeCloseTo(V_NOM);
  });

  it("distinto φ con iguales módulos ya desplaza el neutro", () => {
    const r = openNeutralVoltages({ a: 10, b: 10, c: 10 }, { a: 1.2, b: 0, c: 0 });
    expect(Math.hypot(r.vn.x, r.vn.y)).toBeGreaterThan(0.01);
  });
});

describe("phaseInstant con desplazamiento", () => {
  it("φ atrasa la senoide en el tiempo", () => {
    const phi = Math.PI / 2;
    // el pico de sin(θ − φ) se corre de θ=90° a θ=180°
    expect(phaseInstant({ 1: 10 }, 0, Math.PI, phi)).toBeCloseTo(10);
    expect(phaseInstant({ 1: 10 }, 0, Math.PI / 2, phi)).toBeCloseTo(0);
  });

  it("no corre los armónicos", () => {
    const th = 0.3;
    const a = phaseInstant({ 3: 4 }, 0, th, 1.1);
    expect(a).toBeCloseTo(4 * Math.sin(3 * th));
  });
});
