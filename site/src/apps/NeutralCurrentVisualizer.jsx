import { useState, useMemo } from "react";
import {
  Zap, RotateCcw, Activity, Waves, AlertTriangle, CheckCircle2, BarChart3,
  Plus, Trash2, AirVent, Microwave, Droplets, Refrigerator, MonitorSmartphone, Lightbulb,
  Unplug, ArrowUp, ArrowDown,
} from "lucide-react";
import {
  I_MAX, F_HZ, T_MS, V_NOM, rad, APPLIANCES, getAppliance, FAULTS,
  buildPhaseSpectrum, harmonicNeutral, phaseInstant, openNeutralVoltages, scaleSpectrum,
} from "./neutralCurrent";

/* -------------------------------------------------------------------------
 * Visualizador de corriente de neutro en sistema trifásico (3F + N)
 * - Sliders = carga lineal base por fase (solo fundamental, ∠ 0/120/240).
 * - Artefactos = cargas no lineales que inyectan armónicos. Los triples (3,9…)
 *   se SUMAN en el neutro aunque el sistema esté balanceado.
 * - Cálculo central en `neutralCurrent.js`; acá sólo se dibuja.
 * ---------------------------------------------------------------------- */

const PHASES = [
  { key: "a", label: "Fase A", angle: 0,   color: "#ef4444" }, // roja
  { key: "b", label: "Fase B", angle: 120, color: "#92400e" }, // marrón
  { key: "c", label: "Fase C", angle: 240, color: "#eab308" }, // amarilla
];

// El neutro siempre se dibuja celeste (la severidad se indica con el texto/ícono).
const NEUTRAL = "#38bdf8";
const ACCENT = "#f59e0b"; // ámbar de la marca (icono y tabs activas)

// Íconos lucide por key de artefacto (catálogo en neutralCurrent.js).
const APP_ICONS = {
  aire: AirVent, micro: Microwave, bomba: Droplets,
  heladera: Refrigerator, pc: MonitorSmartphone, led: Lightbulb,
};

const PRESETS = [
  { label: "Sin carga base", v: { a: 0, b: 0, c: 0 } },
  { label: "Balanceado", v: { a: 10, b: 10, c: 10 } },
  { label: "3 / 7 / 7",  v: { a: 3,  b: 7,  c: 7  } },
  { label: "10 / 7 / 7", v: { a: 10, b: 7,  c: 7  } },
  { label: "Monofásico 30/0/0", v: { a: 30, b: 0, c: 0 } },
];

const fmt = (n) => n.toFixed(1);
let _uid = 0;

export default function NeutralCurrentVisualizer() {
  const [I, setI] = useState({ a: 10, b: 10, c: 10 });
  const [appliances, setAppliances] = useState([]); // [{id, key, phase}]
  const [target, setTarget] = useState("3f");        // fase destino: a|b|c|3f
  const [tab, setTab] = useState("phasors");
  const [vis, setVis] = useState({ a: true, b: true, c: true, n: true }); // trazas visibles
  // Fallas combinables: corte de cada fase (a/b/c) y/o del neutro (n).
  const [faults, setFaults] = useState({ a: false, b: false, c: false, n: false });

  const toggleVis = (k) => setVis((s) => ({ ...s, [k]: !s[k] }));
  const toggleFault = (k) => setFaults((s) => ({ ...s, [k]: !s[k] }));
  const clearFaults = () => setFaults({ a: false, b: false, c: false, n: false });

  const set = (k, val) => setI((s) => ({ ...s, [k]: Number(val) }));

  const addAppliance = (key) => {
    const phases = target === "3f" ? ["a", "b", "c"] : [target];
    setAppliances((s) => [
      ...s,
      ...phases.map((phase) => ({ id: ++_uid, key, phase })),
    ]);
  };
  const removeAppliance = (id) => setAppliances((s) => s.filter((a) => a.id !== id));
  const clearAppliances = () => setAppliances([]);

  /* ---- espectro por fase (base + artefactos), falla y cálculo central ---- */
  const { spectra, In, comp, fund, perHarmonic, severity, faultV } = useMemo(() => {
    const base = {};
    for (const { key } of PHASES) {
      const apps = appliances
        .filter((a) => a.phase === key)
        .map((a) => getAppliance(a.key));
      base[key] = buildPhaseSpectrum(I[key], apps);
    }

    // Corte de fase(s): esas líneas quedan sin corriente.
    for (const k of ["a", "b", "c"]) if (faults[k]) base[k] = {};

    // Corte de neutro: no hay retorno (In = 0) y las tensiones se desplazan.
    // Sólo cuentan las fases activas; cargas resistivas -> la corriente escala
    // con su tensión. (Combinable con cortes de fase: ésas ya tienen fund 0.)
    if (faults.n) {
      const nominalFund = { a: base.a[1] || 0, b: base.b[1] || 0, c: base.c[1] || 0 };
      const ov = openNeutralVoltages(nominalFund);
      const scaled = {
        a: scaleSpectrum(base.a, ov.ratio.a),
        b: scaleSpectrum(base.b, ov.ratio.b),
        c: scaleSpectrum(base.c, ov.ratio.c),
      };
      const calc = harmonicNeutral(scaled);
      return {
        spectra: scaled, faultV: ov,
        In: 0, comp: { x: 0, y: 0 }, fund: calc.fund,
        perHarmonic: [], severity: "ok",
      };
    }

    return { spectra: base, faultV: null, ...harmonicNeutral(base) };
  }, [I, appliances, faults]);

  const neutralOpen = faults.n;
  const sevColor = NEUTRAL;
  // ¿hay distorsión? (algún armónico > fundamental). Habilita vista de armónicos.
  const harmonicAmps = perHarmonic.filter((p) => p.h !== 1 && p.mag > 0.05);
  const triplenIn = Math.sqrt(
    perHarmonic.filter((p) => p.triplen).reduce((s, p) => s + p.mag * p.mag, 0)
  );

  return (
    <div className="w-full min-h-full bg-slate-950 text-slate-100 p-4 sm:p-6 font-sans">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-2">
              <Zap size={20} style={{ color: ACCENT }} />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight">
                Corriente de Neutro · Sistema Trifásico
              </h1>
              <p className="text-xs text-slate-500 font-mono">
                {F_HZ} Hz · T = {T_MS} ms · fundamental + armónicos · ∠ fijos 0/120/240°
              </p>
            </div>
          </div>
          <StatusBadge severity={severity} faults={faults} color={sevColor} />
        </header>

        {/* Métricas: fundamental por fase + corriente de neutro (salida clave) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {PHASES.map((p) => (
            <Metric key={p.key} label={p.label} value={fund[p.key]} unit="A"
              color={p.color} sub={`∠ ${p.angle}° · fundamental`} />
          ))}
          <NeutralMetric In={In} color={sevColor} />
        </div>

        <div className="grid lg:grid-cols-12 gap-4 items-start">
          {/* Controles (carga base + fallas) */}
          <section className="lg:col-span-4 space-y-4">
            <Card title="Carga lineal base por fase" icon={<Activity size={15} />}>
              <div className="space-y-4 pt-1">
                {PHASES.map((p) => (
                  <Slider key={p.key} phase={p} value={I[p.key]} onChange={(v) => set(p.key, v)} />
                ))}
              </div>
              <div className="mt-4 border-t border-slate-800 pt-3">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-2">
                  <RotateCcw size={11} /> Presets
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.map((pr) => (
                    <button key={pr.label} onClick={() => setI(pr.v)}
                      className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1.5 text-xs
                                 text-slate-300 hover:border-slate-600 hover:bg-slate-800 transition-colors">
                      {pr.label}
                    </button>
                  ))}
                </div>
              </div>
            </Card>

            <FaultCard faults={faults} onToggle={toggleFault} onClear={clearFaults} />
          </section>

          {/* Visualización + detalle del neutro */}
          <section className="lg:col-span-8 space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
              <div className="flex border-b border-slate-800">
                <TabBtn active={tab === "phasors"} onClick={() => setTab("phasors")}
                  icon={<Activity size={14} />} label="Fasores" />
                <TabBtn active={tab === "waves"} onClick={() => setTab("waves")}
                  icon={<Waves size={14} />} label="Ondas" />
                <TabBtn active={tab === "harm"} onClick={() => setTab("harm")}
                  icon={<BarChart3 size={14} />} label="Armónicos" />
              </div>
              <div className="p-4">
                {tab === "phasors" && <PhasorView I={fund} comp={comp} nColor={sevColor} vis={vis} onToggle={toggleVis} neutralOpen={neutralOpen} />}
                {tab === "waves" && <WaveView spectra={spectra} In={In} nColor={sevColor} vis={vis} onToggle={toggleVis} neutralOpen={neutralOpen} />}
                {tab === "harm" && <HarmonicView perHarmonic={perHarmonic} In={In} nColor={sevColor} />}
              </div>
            </div>

            {neutralOpen
              ? <VoltagePanel ov={faultV} faults={faults} />
              : <NeutralCard In={In} color={sevColor} triplenIn={triplenIn} hasHarm={harmonicAmps.length > 0} faults={faults} />}
          </section>

          {/* Artefactos: ancho completo abajo, catálogo + conectados en dos columnas */}
          <section className="lg:col-span-12">
            <AppliancesCard
              appliances={appliances} target={target} setTarget={setTarget}
              onAdd={addAppliance} onRemove={removeAppliance} onClear={clearAppliances} />
          </section>
        </div>
      </div>
    </div>
  );
}

/* ===================== Subcomponentes UI ===================== */

const DANGER = "#f43f5e"; // rojo-rosa para fallas

// Texto corto que resume las fallas activas.
function faultSummary(faults) {
  const cut = ["a", "b", "c"].filter((k) => faults[k]).map((k) => k.toUpperCase());
  const parts = [];
  if (cut.length)
    parts.push(`Fase${cut.length > 1 ? "s" : ""} ${cut.join("/")} cortada${cut.length > 1 ? "s" : ""}`);
  if (faults.n) parts.push("Neutro abierto");
  return parts.join(" + ");
}

function StatusBadge({ severity, faults, color }) {
  // Las fallas mandan sobre la severidad normal.
  if (faults.a || faults.b || faults.c || faults.n)
    return <Badge color={DANGER} Icon={Unplug} txt={faultSummary(faults)} />;

  const map = {
    ok:   { txt: "Balanceado",    Icon: CheckCircle2, c: color },
    warn: { txt: "Desbalanceado", Icon: AlertTriangle, c: color },
    high: { txt: "Neutro cargado", Icon: AlertTriangle, c: color },
  };
  const { txt, Icon, c } = map[severity];
  return <Badge color={c} Icon={Icon} txt={txt} />;
}

function Badge({ color, Icon, txt }) {
  return (
    <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium"
      style={{ borderColor: color + "66", color, backgroundColor: color + "14" }}>
      <Icon size={14} /> {txt}
    </div>
  );
}

function Metric({ label, value, unit, color, sub }) {
  return (
    <div className="rounded-xl border bg-slate-900 p-3" style={{ borderColor: color + "33" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">{label}</span>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-mono font-semibold tabular-nums" style={{ color }}>{fmt(value)}</span>
        <span className="text-sm text-slate-500 font-mono">{unit}</span>
      </div>
      <span className="text-[10px] text-slate-600 font-mono">{sub}</span>
    </div>
  );
}

// Métrica destacada de la corriente de neutro (4ª celda de la fila superior).
function NeutralMetric({ In, color }) {
  const pct = Math.min(100, (In / I_MAX) * 100);
  return (
    <div className="rounded-xl border bg-slate-900 p-3"
      style={{ borderColor: color + "66", backgroundColor: color + "0d" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color }}>Corriente de Neutro</span>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-mono font-bold tabular-nums" style={{ color }}>{fmt(In)}</span>
        <span className="text-sm text-slate-500 font-mono">A · I<sub>N</sub></span>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-150"
          style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function AppliancesCard({ appliances, target, setTarget, onAdd, onRemove, onClear }) {
  const targets = [
    { k: "a", label: "A" }, { k: "b", label: "B" },
    { k: "c", label: "C" }, { k: "3f", label: "3φ" },
  ];
  return (
    <Card title="Artefactos (armónicos)" icon={<Plus size={15} />}>
      <div className="grid md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
        {/* columna izquierda: destino + catálogo */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Agregar a la fase</span>
            <div className="flex gap-1">
              {targets.map((t) => (
                <button key={t.k} onClick={() => setTarget(t.k)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-mono transition-colors ${
                    target === t.k
                      ? "border-amber-500 bg-amber-500/10 text-amber-300"
                      : "border-slate-800 bg-slate-950/50 text-slate-400 hover:border-slate-600"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {APPLIANCES.map((a) => {
              const Icon = APP_ICONS[a.key] ?? Plus;
              return (
                <button key={a.key} onClick={() => onAdd(a.key)}
                  className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-2 py-2
                             text-xs text-slate-300 hover:border-amber-500/60 hover:bg-slate-800 transition-colors text-left">
                  <Icon size={16} style={{ color: ACCENT }} className="shrink-0" />
                  <span className="leading-tight">{a.label}<br />
                    <span className="text-[10px] text-slate-600 font-mono">{a.current} A</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* columna derecha: conectados */}
        <div className="md:border-l md:border-slate-800 md:pl-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Conectados ({appliances.length})
            </span>
            {appliances.length > 0 && (
              <button onClick={onClear}
                className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-400 transition-colors">
                <Trash2 size={11} /> Limpiar
              </button>
            )}
          </div>
          {appliances.length === 0 ? (
            <p className="text-xs text-slate-600 leading-relaxed">
              Sin artefactos. Elegí una fase (o 3φ) y tocá un artefacto para agregarlo.
              Probá agregar el mismo a las 3 fases para ver cómo cargan el neutro vía 3ª armónica.
            </p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-x-3 gap-y-1 max-h-44 overflow-y-auto pr-1">
              {appliances.map((a) => {
                const meta = getAppliance(a.key);
                const Icon = APP_ICONS[a.key] ?? Plus;
                const ph = PHASES.find((p) => p.key === a.phase);
                return (
                  <div key={a.id}
                    className="flex items-center gap-2 rounded-md bg-slate-950/60 px-2 py-1 text-xs">
                    <Icon size={13} className="shrink-0 text-slate-400" />
                    <span className="flex-1 truncate text-slate-300">{meta?.label}</span>
                    <span className="h-2 w-2 rounded-sm shrink-0" style={{ backgroundColor: ph?.color }} />
                    <span className="font-mono text-[10px] text-slate-500 w-3">{ph?.label.slice(-1)}</span>
                    <button onClick={() => onRemove(a.id)} className="text-slate-600 hover:text-rose-400">
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// Botones (toggles) para simular fallas combinables: cortes de fase y/o neutro.
function FaultCard({ faults, onToggle, onClear }) {
  const any = faults.a || faults.b || faults.c || faults.n;
  return (
    <Card title="Simular fallas" icon={<Unplug size={15} />}>
      <div className="flex items-center justify-between mb-2 pt-1">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Combinables</span>
        {any && (
          <button onClick={onClear}
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-emerald-400 transition-colors">
            <CheckCircle2 size={11} /> Sin fallas
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {FAULTS.map((f) => {
          const active = faults[f.key];
          return (
            <button key={f.key} onClick={() => onToggle(f.key)}
              className={`flex items-center gap-2 rounded-md border px-2 py-2 text-xs transition-colors ${
                active
                  ? "border-rose-500 bg-rose-500/10 text-rose-300"
                  : "border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-600 hover:bg-slate-800"
              }`}>
              <span className={`h-2 w-2 rounded-full shrink-0 ${active ? "bg-rose-400" : "bg-slate-700"}`} />
              {f.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-slate-600 leading-relaxed">
        Corte de fase: esa línea queda sin corriente y el neutro carga el desbalance.
        Corte de neutro: I<sub>N</sub> = 0 pero las tensiones se desplazan (peligro).
        Se pueden activar varias a la vez (p. ej. una fase + neutro).
      </p>
    </Card>
  );
}

// Panel de tensiones cuando el neutro queda abierto (estrella flotante).
function VoltagePanel({ ov, faults }) {
  const rows = PHASES.map((p) => {
    const cut = faults[p.key];
    const V = ov.V[p.key];
    const pct = (ov.ratio[p.key] - 1) * 100;
    return { p, cut, V, pct, over: pct > 5, under: pct < -5 };
  });
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: DANGER + "55", backgroundColor: DANGER + "0d" }}>
      <div className="flex items-center gap-2 text-sm font-medium" style={{ color: DANGER }}>
        <Unplug size={15} /> {faultSummary(faults)} · tensión de fase
      </div>
      <p className="mt-1 text-xs text-slate-400 leading-relaxed">
        Sin retorno, I<sub>N</sub> = 0; pero el punto estrella se desplaza y la tensión sobre cada
        carga cambia. Las fases poco cargadas <b className="text-slate-200">sobretensionan</b> (peligro
        para los equipos).
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {rows.map(({ p, cut, V, pct, over, under }) => {
          const c = cut ? "#64748b" : over ? DANGER : under ? "#eab308" : "#94a3b8";
          const Icon = over ? ArrowUp : under ? ArrowDown : null;
          return (
            <div key={p.key} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
                <span className="text-xs text-slate-400">{p.label}</span>
              </div>
              {cut ? (
                <div className="mt-1 text-sm font-mono text-slate-500">cortada</div>
              ) : (
                <>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-xl font-mono font-bold tabular-nums" style={{ color: c }}>
                      {Math.round(V)}
                    </span>
                    <span className="text-xs text-slate-500 font-mono">V</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] font-mono" style={{ color: c }}>
                    {Icon && <Icon size={11} />}
                    {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-slate-600 font-mono">
        Referencia: V<sub>nominal</sub> = {V_NOM} V · carga modelada como resistiva.
      </p>
    </div>
  );
}

// Detalle/explicación de la corriente de neutro (debajo de la visualización).
function NeutralCard({ In, color, triplenIn, hasHarm, faults }) {
  const cut = ["a", "b", "c"].filter((k) => faults[k]).map((k) => k.toUpperCase());
  const phaseCut = cut.length > 0;
  return (
    <div className="rounded-xl border bg-slate-900 p-4" style={{ borderColor: color + "44" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-mono font-bold tabular-nums" style={{ color }}>{fmt(In)}</span>
          <span className="text-sm text-slate-500 font-mono">A en el neutro</span>
        </div>
        {hasHarm && (
          <div className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-mono"
            style={{ borderColor: color + "55", color, backgroundColor: color + "12" }}>
            <BarChart3 size={13} /> {fmt(triplenIn)} A de armónicos triples
          </div>
        )}
      </div>
      {phaseCut ? (
        <p className="mt-2 text-xs text-slate-400 leading-relaxed">
          <b className="text-rose-300">Fase{cut.length > 1 ? "s" : ""} {cut.join("/")} cortada{cut.length > 1 ? "s" : ""}</b>:
          sin corriente en esa(s) línea(s), el neutro tiene que conducir todo el desbalance de las fases restantes.
        </p>
      ) : hasHarm ? (
        <p className="mt-2 text-xs text-slate-400 leading-relaxed">
          <span className="font-mono text-slate-500">I<sub>N</sub> = √(Σ |I<sub>N,h</sub>|²)</span>.
          Los armónicos triples (3ª, 9ª…) están en fase en las tres líneas y se{" "}
          <b className="text-slate-200">suman</b> en el neutro aunque las fases estén balanceadas — por eso
          el neutro puede conducir corriente sin que haya desbalance.
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-500 leading-relaxed">
          <span className="font-mono">I<sub>N</sub> = √(Ia²+Ib²+Ic² − Ia·Ib − Ib·Ic − Ic·Ia)</span> ·
          solo fundamental, sin armónicos. Agregá artefactos para ver cómo cargan el neutro.
        </p>
      )}
    </div>
  );
}

function Slider({ phase, value, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: phase.color }} />
          <span className="text-sm text-slate-300">{phase.label}</span>
          <span className="text-[10px] text-slate-600 font-mono">∠{phase.angle}°</span>
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: phase.color }}>
          {fmt(value)} A
        </span>
      </div>
      <input type="range" min={0} max={I_MAX} step={0.5} value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer"
        style={{ accentColor: phase.color }} />
    </div>
  );
}

function Card({ title, icon, children }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        {icon}<span className="uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors
        ${active ? "text-slate-100 border-b-2" : "text-slate-500 border-b-2 border-transparent hover:text-slate-300"}`}
      style={active ? { borderColor: ACCENT } : undefined}>
      {icon}{label}
    </button>
  );
}

/* ===================== Vista: Diagrama Fasorial ===================== */

function PhasorView({ I, comp, nColor, vis, onToggle, neutralOpen }) {
  const VB = 340, C = VB / 2, R = 140, scale = R / I_MAX;
  const In = Math.hypot(comp.x, comp.y); // resultante de la fundamental

  // tip de cada fasor en coords de pantalla (y invertida)
  const tip = (mag, angle) => ({
    x: C + mag * Math.cos(rad(angle)) * scale,
    y: C - mag * Math.sin(rad(angle)) * scale,
  });
  const nTip = { x: C + comp.x * scale, y: C - comp.y * scale };

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="w-full" style={{ maxWidth: 420 }}>
        {/* graticule */}
        {[10, 20, 30].map((r) => (
          <circle key={r} cx={C} cy={C} r={r * scale} fill="none"
            stroke="#1e293b" strokeWidth={1} />
        ))}
        {[10, 20, 30].map((r) => (
          <text key={`t${r}`} x={C + 3} y={C - r * scale + 11} fill="#475569"
            fontSize={9} fontFamily="monospace">{r}A</text>
        ))}
        {/* ejes */}
        <line x1={10} y1={C} x2={VB - 10} y2={C} stroke="#334155" strokeWidth={1} />
        <line x1={C} y1={10} x2={C} y2={VB - 10} stroke="#334155" strokeWidth={1} />

        {/* fasores de fase */}
        {PHASES.map((p) => {
          const t = tip(I[p.key], p.angle);
          if (I[p.key] < 0.05 || !vis[p.key]) return null;
          return <Arrow key={p.key} x1={C} y1={C} x2={t.x} y2={t.y} color={p.color} width={2.5} />;
        })}

        {/* neutro (resultante de la fundamental) punteado */}
        {In >= 0.05 && vis.n && (
          <Arrow x1={C} y1={C} x2={nTip.x} y2={nTip.y} color={nColor} width={3} dashed glow />
        )}
        <circle cx={C} cy={C} r={3} fill="#64748b" />
      </svg>

      <Legend nColor={nColor} note={neutralOpen ? "abierto · I_N = 0" : `I_N fund. ≈ ${fmt(In)} A`}
        vis={vis} onToggle={onToggle} neutralOpen={neutralOpen} />
      <p className="mt-1 text-[10px] text-slate-600 font-mono text-center">
        El diagrama fasorial muestra solo la fundamental. Los armónicos se ven en las otras pestañas.
      </p>
    </div>
  );
}

function Arrow({ x1, y1, x2, y2, color, width, dashed, glow }) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const h = 9, spread = 0.42;
  const lx = x2 - h * Math.cos(ang - spread), ly = y2 - h * Math.sin(ang - spread);
  const rx = x2 - h * Math.cos(ang + spread), ry = y2 - h * Math.sin(ang + spread);
  const len = Math.hypot(x2 - x1, y2 - y1);
  return (
    <g style={glow ? { filter: `drop-shadow(0 0 4px ${color})` } : undefined}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width}
        strokeLinecap="round" strokeDasharray={dashed ? "6 4" : undefined} />
      {len > 6 && <polygon points={`${x2},${y2} ${lx},${ly} ${rx},${ry}`} fill={color} />}
    </g>
  );
}

/* ===================== Vista: Formas de Onda ===================== */

function WaveView({ spectra, In, nColor, vis, onToggle, neutralOpen }) {
  const W = 560, H = 260, padL = 40, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const cY = padT + plotH / 2;
  const N = 220;

  // muestreo: ip(t) = Σ_h mag·sin(hθ + h·∠fase), in(t) = ia+ib+ic
  const { paths, nPath, yMax } = useMemo(() => {
    const acc = { a: [], b: [], c: [], n: [] };
    const raw = { a: [], b: [], c: [], n: [] };
    let peak = 1;
    for (let i = 0; i <= N; i++) {
      const ms = (i / N) * T_MS;
      const th = (ms / T_MS) * 2 * Math.PI;
      const ia = phaseInstant(spectra.a, 0, th);
      const ib = phaseInstant(spectra.b, 120, th);
      const ic = phaseInstant(spectra.c, 240, th);
      const inst = ia + ib + ic;
      raw.a.push([ms, ia]); raw.b.push([ms, ib]); raw.c.push([ms, ic]); raw.n.push([ms, inst]);
      peak = Math.max(peak, Math.abs(ia), Math.abs(ib), Math.abs(ic), Math.abs(inst));
    }
    const yMax = Math.ceil(peak / 10) * 10 || 10;
    const yS = (plotH / 2) / yMax;
    const x = (ms) => padL + (ms / T_MS) * plotW;
    const y = (amp) => cY - amp * yS;
    for (const k of ["a", "b", "c", "n"])
      for (const [ms, v] of raw[k]) acc[k].push([x(ms), y(v)]);
    const toStr = (arr) => arr.map((p) => p.join(",")).join(" ");
    return {
      paths: PHASES.map((p) => ({ key: p.key, color: p.color, pts: toStr(acc[p.key]) })),
      nPath: toStr(acc.n),
      yMax,
    };
  }, [spectra]);

  const yS = (plotH / 2) / yMax;
  const y = (amp) => cY - amp * yS;
  const x = (ms) => padL + (ms / T_MS) * plotW;
  const ticks = [-yMax, -yMax / 2, 0, yMax / 2, yMax];

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* grilla horizontal (amperios) */}
        {ticks.map((a) => (
          <g key={a}>
            <line x1={padL} y1={y(a)} x2={W - padR} y2={y(a)}
              stroke={a === 0 ? "#334155" : "#1e293b"} strokeWidth={1} />
            <text x={padL - 5} y={y(a) + 3} textAnchor="end" fill="#475569"
              fontSize={9} fontFamily="monospace">{Math.round(a)}</text>
          </g>
        ))}
        {/* grilla vertical (ms) */}
        {[0, 5, 10, 15, 20].map((ms) => (
          <g key={ms}>
            <line x1={x(ms)} y1={padT} x2={x(ms)} y2={H - padB}
              stroke="#1e293b" strokeWidth={1} />
            <text x={x(ms)} y={H - padB + 14} textAnchor="middle" fill="#475569"
              fontSize={9} fontFamily="monospace">{ms}ms</text>
          </g>
        ))}

        {/* ondas de fase (distorsionadas por armónicos) */}
        {paths.filter((p) => vis[p.key]).map((p) => (
          <polyline key={p.key} points={p.pts} fill="none" stroke={p.color}
            strokeWidth={2} strokeLinejoin="round" />
        ))}
        {/* onda del neutro: punteada para que la fase de abajo se vea cuando coinciden */}
        {vis.n && !neutralOpen && (
          <polyline points={nPath} fill="none" stroke={nColor} strokeWidth={2.5}
            strokeDasharray="7 5" strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${nColor})` }} />
        )}
      </svg>

      <Legend nColor={nColor} note={neutralOpen ? "abierto · I_N = 0" : `I_N rms ≈ ${fmt(In)} A`}
        dashed vis={vis} onToggle={onToggle} neutralOpen={neutralOpen} />
      <p className="mt-1 text-[10px] text-slate-600 font-mono text-center">
        {neutralOpen
          ? "Neutro abierto: no circula corriente de retorno; las fases muestran la corriente con la tensión desplazada."
          : "El neutro (punteado) = suma instantánea de las tres fases. Con una sola fase cargada se superpone con ella."}
      </p>
    </div>
  );
}

/* ===================== Vista: Armónicos del Neutro ===================== */

function HarmonicView({ perHarmonic, In, nColor }) {
  const bars = perHarmonic.filter((p) => p.mag > 0.01);
  const max = Math.max(In, ...bars.map((b) => b.mag), 1);
  const W = 560, H = 260, padL = 40, padR = 16, padT = 16, padB = 36;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const baseY = padT + plotH;
  const slot = plotW / Math.max(bars.length, 1);
  const bw = Math.min(48, slot * 0.6);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* eje base */}
        <line x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke="#334155" strokeWidth={1} />
        {bars.map((b, i) => {
          const h = (b.mag / max) * plotH;
          const cx = padL + slot * i + slot / 2;
          const fill = b.h === 1 ? "#64748b" : b.triplen ? nColor : "#475569";
          return (
            <g key={b.h}>
              <rect x={cx - bw / 2} y={baseY - h} width={bw} height={h} rx={2}
                fill={fill} opacity={b.triplen || b.h === 1 ? 0.95 : 0.6} />
              <text x={cx} y={baseY - h - 5} textAnchor="middle" fill="#94a3b8"
                fontSize={9} fontFamily="monospace">{fmt(b.mag)}</text>
              <text x={cx} y={baseY + 14} textAnchor="middle"
                fill={b.triplen ? nColor : "#64748b"} fontSize={10} fontFamily="monospace">
                {b.h}ª
              </text>
              {b.triplen && (
                <text x={cx} y={baseY + 26} textAnchor="middle" fill="#475569"
                  fontSize={8} fontFamily="monospace">triple</text>
              )}
            </g>
          );
        })}
        {bars.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="#475569"
            fontSize={12} fontFamily="monospace">Sin corriente de neutro</text>
        )}
      </svg>

      <p className="mt-2 text-[11px] text-slate-400 text-center max-w-md leading-relaxed">
        Aporte de cada armónico a I<sub>N</sub>. Los <span style={{ color: nColor }}>triples (3ª, 9ª…)</span>{" "}
        están en fase en las tres líneas y se <b>suman</b>; el resto se cancela si el sistema está balanceado.
      </p>
      <Legend nColor={nColor} note={`I_N rms ≈ ${fmt(In)} A`} />
    </div>
  );
}

function Legend({ nColor, note, dashed, vis, onToggle, neutralOpen }) {
  // Si onToggle está, cada ítem es un botón para mostrar/ocultar esa traza.
  const interactive = typeof onToggle === "function";
  const swatch = (color, dash) =>
    dash ? (
      <svg width={14} height={4} className="overflow-visible shrink-0">
        <line x1={0} y1={2} x2={14} y2={2} stroke={color} strokeWidth={2.5}
          strokeDasharray="4 3" strokeLinecap="round" />
      </svg>
    ) : (
      <span className="h-2 w-3 rounded-sm shrink-0" style={{ backgroundColor: color }} />
    );

  const item = (key, label, color, { dash = false, bold = false } = {}) => {
    const on = !interactive || (vis && vis[key]);
    const base = `flex items-center gap-1.5 ${bold ? "font-medium" : ""}`;
    const content = (
      <>
        {swatch(on ? color : "#475569", dash)}
        <span style={{ textDecoration: on ? "none" : "line-through" }}>{label}</span>
      </>
    );
    if (!interactive)
      return (
        <span key={key} className={base} style={{ color: bold ? color : undefined }}>
          {content}
        </span>
      );
    return (
      <button key={key} onClick={() => onToggle(key)}
        title={on ? "Ocultar" : "Mostrar"}
        className={`${base} rounded-md px-2 py-1 transition-colors hover:bg-slate-800/70`}
        style={{ color: on ? (bold ? color : "#94a3b8") : "#64748b" }}>
        {content}
      </button>
    );
  };

  // Con el neutro abierto no tiene sentido togglear su traza (no existe).
  const neutralLabel = `Neutro${note ? ` · ${note}` : ""}`;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs">
      {PHASES.map((p) => item(p.key, p.label, p.color))}
      {neutralOpen ? (
        <span className="flex items-center gap-1.5 font-medium text-slate-600">
          <Unplug size={12} /> {neutralLabel}
        </span>
      ) : (
        item("n", neutralLabel, nColor, { dash: dashed, bold: true })
      )}
    </div>
  );
}
