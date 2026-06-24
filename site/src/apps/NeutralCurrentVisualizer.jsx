import { useState, useMemo, useEffect, useRef } from "react";
import {
  Zap, RotateCcw, Activity, Waves, AlertTriangle, CheckCircle2, BarChart3,
  Plus, Trash2, AirVent, Microwave, Droplets, Refrigerator, MonitorSmartphone, Lightbulb,
  Unplug, ArrowUp, ArrowDown, Gauge, Cable, GripVertical, ChevronUp, ChevronDown,
} from "lucide-react";
import {
  I_MAX, F_HZ, T_MS, V_NOM, rad, APPLIANCES, getAppliance, FAULTS, CABLE_SECTIONS,
  buildPhaseSpectrum, harmonicNeutral, phaseInstant, openNeutralVoltages, scaleSpectrum,
  cableResistance, solveVoltages,
} from "./neutralCurrent";

/* -------------------------------------------------------------------------
 * Visualizador de corriente de neutro en sistema trifásico (3F + N)
 * - Sliders = carga lineal base por fase (solo fundamental, ∠ 0/120/240).
 * - Artefactos = cargas no lineales que inyectan armónicos. Los triples (3,9…)
 *   se SUMAN en el neutro aunque el sistema esté balanceado.
 * - Cableado por conductor (largo + sección) -> caída de tensión y, con el
 *   neutro, su desplazamiento. Fallas combinables (corte de fase y/o neutro).
 * - Los paneles se pueden reordenar (drag o flechas) y el orden se guarda.
 * - Cálculo central en `neutralCurrent.js`; acá sólo se dibuja.
 * ---------------------------------------------------------------------- */

const PHASES = [
  { key: "a", label: "Fase A", angle: 0,   color: "#ef4444" }, // roja
  { key: "b", label: "Fase B", angle: 120, color: "#92400e" }, // marrón
  { key: "c", label: "Fase C", angle: 240, color: "#eab308" }, // amarilla
];

const NEUTRAL = "#38bdf8";
const ACCENT = "#f59e0b"; // ámbar de la marca
const DANGER = "#f43f5e"; // rojo-rosa para fallas

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

/* ---- orden de paneles persistido en localStorage ---- */
const PANEL_KEY = "ncv:panel-order:v1";
const DEFAULT_PANEL_ORDER = ["metrics", "viz", "load", "faults", "cables", "appliances"];

function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY));
    if (!Array.isArray(saved)) return DEFAULT_PANEL_ORDER;
    const known = new Set(DEFAULT_PANEL_ORDER);
    const out = saved.filter((id) => known.has(id));
    for (const id of DEFAULT_PANEL_ORDER) if (!out.includes(id)) out.push(id);
    return out;
  } catch {
    return DEFAULT_PANEL_ORDER;
  }
}

function usePanelOrder() {
  const [order, setOrder] = useState(loadOrder);
  const [draggingId, setDraggingId] = useState(null);
  const dragId = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(order)); } catch { /* ignore */ }
  }, [order]);

  const reorder = (from, to) =>
    setOrder((prev) => {
      const a = [...prev];
      const fi = a.indexOf(from);
      const ti = a.indexOf(to);
      if (fi < 0 || ti < 0 || fi === ti) return prev;
      a.splice(fi, 1);
      a.splice(ti, 0, from);
      return a;
    });

  return {
    order,
    draggingId,
    isDefault: order.join() === DEFAULT_PANEL_ORDER.join(),
    onDragStart: (id) => (e) => {
      dragId.current = id;
      setDraggingId(id);
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ }
    },
    onDragEnd: () => { dragId.current = null; setDraggingId(null); },
    onDragOver: (id) => (e) => {
      e.preventDefault();
      if (dragId.current && dragId.current !== id) reorder(dragId.current, id);
    },
    onDrop: (e) => e.preventDefault(),
    move: (id, dir) =>
      setOrder((prev) => {
        const a = [...prev];
        const i = a.indexOf(id);
        const j = i + dir;
        if (j < 0 || j >= a.length) return prev;
        [a[i], a[j]] = [a[j], a[i]];
        return a;
      }),
    reset: () => setOrder(DEFAULT_PANEL_ORDER),
  };
}

export default function NeutralCurrentVisualizer() {
  const [I, setI] = useState({ a: 10, b: 10, c: 10 });
  const [appliances, setAppliances] = useState([]); // [{id, key, phase}]
  const [target, setTarget] = useState("3f");        // fase destino: a|b|c|3f
  const [tab, setTab] = useState("phasors");
  const [vis, setVis] = useState({ a: true, b: true, c: true, n: true }); // trazas visibles
  const [faults, setFaults] = useState({ a: false, b: false, c: false, n: false });
  const [cables, setCables] = useState({
    a: { L: 20, A: 4 }, b: { L: 20, A: 4 }, c: { L: 20, A: 4 }, n: { L: 20, A: 4 },
  });
  const dnd = usePanelOrder();

  const toggleVis = (k) => setVis((s) => ({ ...s, [k]: !s[k] }));
  const toggleFault = (k) => setFaults((s) => ({ ...s, [k]: !s[k] }));
  const clearFaults = () => setFaults({ a: false, b: false, c: false, n: false });
  const setLoad = (k, val) => setI((s) => ({ ...s, [k]: Number(val) }));
  const setCable = (k, field, val) =>
    setCables((s) => ({ ...s, [k]: { ...s[k], [field]: Number(val) } }));

  const addAppliance = (key) => {
    const phases = target === "3f" ? ["a", "b", "c"] : [target];
    setAppliances((s) => [...s, ...phases.map((phase) => ({ id: ++_uid, key, phase }))]);
  };
  const removeAppliance = (id) => setAppliances((s) => s.filter((a) => a.id !== id));
  const clearAppliances = () => setAppliances([]);

  /* ---- espectro por fase (base + artefactos), falla y cálculo central ---- */
  const { spectra, In, comp, fund, perHarmonic, severity } = useMemo(() => {
    const base = {};
    for (const { key } of PHASES) {
      const apps = appliances.filter((a) => a.phase === key).map((a) => getAppliance(a.key));
      base[key] = buildPhaseSpectrum(I[key], apps);
    }
    for (const k of ["a", "b", "c"]) if (faults[k]) base[k] = {};

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
        spectra: scaled, In: 0, comp: { x: 0, y: 0 },
        fund: calc.fund, perHarmonic: [], severity: "ok",
      };
    }
    return { spectra: base, ...harmonicNeutral(base) };
  }, [I, appliances, faults]);

  /* ---- resistencias de cable y tensiones de carga (fundamental) ---- */
  const { R, Rn } = useMemo(() => {
    const R = {};
    for (const p of PHASES) R[p.key] = cableResistance(cables[p.key].L, cables[p.key].A);
    const Rn = faults.n ? Infinity : cableResistance(cables.n.L, cables.n.A);
    return { R, Rn };
  }, [cables, faults.n]);

  const volt = useMemo(() => {
    const G = {};
    for (const p of PHASES) {
      const apps = appliances.filter((a) => a.phase === p.key).map((a) => getAppliance(a.key));
      const spec = buildPhaseSpectrum(I[p.key], apps);
      G[p.key] = (faults[p.key] ? 0 : (spec[1] || 0)) / V_NOM;
    }
    return solveVoltages({ G, R, Rn });
  }, [I, appliances, faults, R, Rn]);

  const neutralOpen = faults.n;
  const sevColor = NEUTRAL;
  const harmonicAmps = perHarmonic.filter((p) => p.h !== 1 && p.mag > 0.05);
  const triplenIn = Math.sqrt(
    perHarmonic.filter((p) => p.triplen).reduce((s, p) => s + p.mag * p.mag, 0)
  );

  const renderPanel = (id) => {
    switch (id) {
      case "metrics":
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {PHASES.map((p) => (
              <Metric key={p.key} label={p.label} value={fund[p.key]} unit="A"
                color={p.color} sub={`∠ ${p.angle}° · fundamental`} />
            ))}
            <NeutralMetric In={In} color={sevColor} />
          </div>
        );
      case "viz":
        return (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
              <div className="flex border-b border-slate-800 overflow-x-auto">
                <TabBtn active={tab === "phasors"} onClick={() => setTab("phasors")}
                  icon={<Activity size={14} />} label="Fasores" />
                <TabBtn active={tab === "waves"} onClick={() => setTab("waves")}
                  icon={<Waves size={14} />} label="Ondas" />
                <TabBtn active={tab === "harm"} onClick={() => setTab("harm")}
                  icon={<BarChart3 size={14} />} label="Armónicos" />
                <TabBtn active={tab === "volts"} onClick={() => setTab("volts")}
                  icon={<Gauge size={14} />} label="Tensión" />
              </div>
              <div className="p-4">
                {tab === "phasors" && <PhasorView I={fund} comp={comp} nColor={sevColor} vis={vis} onToggle={toggleVis} neutralOpen={neutralOpen} />}
                {tab === "waves" && <WaveView spectra={spectra} In={In} nColor={sevColor} vis={vis} onToggle={toggleVis} neutralOpen={neutralOpen} />}
                {tab === "harm" && <HarmonicView perHarmonic={perHarmonic} In={In} nColor={sevColor} />}
                {tab === "volts" && <VoltageView volt={volt} spectra={spectra} R={R} Rn={Rn} faults={faults} neutralOpen={neutralOpen} vis={vis} onToggle={toggleVis} />}
              </div>
            </div>
            {neutralOpen
              ? <VoltagePanel volt={volt} faults={faults} />
              : <NeutralCard In={In} color={sevColor} triplenIn={triplenIn} hasHarm={harmonicAmps.length > 0} faults={faults} />}
          </div>
        );
      case "load":
        return <LoadCard I={I} onChange={setLoad} onPreset={setI} />;
      case "faults":
        return <FaultCard faults={faults} onToggle={toggleFault} onClear={clearFaults} />;
      case "cables":
        return <CableCard cables={cables} onChange={setCable} />;
      case "appliances":
        return (
          <AppliancesCard
            appliances={appliances} target={target} setTarget={setTarget}
            onAdd={addAppliance} onRemove={removeAppliance} onClear={clearAppliances} />
        );
      default:
        return null;
    }
  };

  return (
    <div className="w-full min-h-full bg-slate-950 text-slate-100 p-4 sm:p-6 font-sans">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 mb-6">
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
          <div className="flex items-center gap-2">
            {!dnd.isDefault && (
              <button onClick={dnd.reset} title="Restablecer el orden de los paneles"
                className="flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs
                           text-slate-400 hover:text-slate-100 hover:border-slate-500 transition-colors">
                <RotateCcw size={13} /> Orden
              </button>
            )}
            <StatusBadge severity={severity} faults={faults} color={sevColor} />
          </div>
        </header>

        {/* Paneles reordenables */}
        <div className="space-y-4">
          {dnd.order.map((id, idx) => (
            <DraggablePanel key={id} id={id} dnd={dnd}
              first={idx === 0} last={idx === dnd.order.length - 1}>
              {renderPanel(id)}
            </DraggablePanel>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ===================== Panel arrastrable ===================== */

function DraggablePanel({ id, dnd, first, last, children }) {
  const dragging = dnd.draggingId === id;
  return (
    <div onDragOver={dnd.onDragOver(id)} onDrop={dnd.onDrop}
      className={`relative group transition-opacity ${dragging ? "opacity-40" : ""}`}>
      <div className="absolute left-1/2 -translate-x-1/2 -top-3 z-20 flex items-center rounded-full
                      border border-slate-700 bg-slate-800 shadow opacity-0 group-hover:opacity-100
                      focus-within:opacity-100 transition-opacity">
        <button onClick={() => dnd.move(id, -1)} disabled={first} title="Subir"
          className="px-1.5 py-0.5 text-slate-400 hover:text-slate-100 disabled:opacity-30">
          <ChevronUp size={12} />
        </button>
        <span draggable onDragStart={dnd.onDragStart(id)} onDragEnd={dnd.onDragEnd}
          title="Arrastrar para reordenar"
          className="px-1 py-0.5 cursor-grab active:cursor-grabbing text-slate-500 hover:text-slate-200">
          <GripVertical size={12} />
        </span>
        <button onClick={() => dnd.move(id, 1)} disabled={last} title="Bajar"
          className="px-1.5 py-0.5 text-slate-400 hover:text-slate-100 disabled:opacity-30">
          <ChevronDown size={12} />
        </button>
      </div>
      {children}
    </div>
  );
}

/* ===================== Subcomponentes UI ===================== */

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
  if (faults.a || faults.b || faults.c || faults.n)
    return <Badge color={DANGER} Icon={Unplug} txt={faultSummary(faults)} />;
  const map = {
    ok:   { txt: "Balanceado",    Icon: CheckCircle2 },
    warn: { txt: "Desbalanceado", Icon: AlertTriangle },
    high: { txt: "Neutro cargado", Icon: AlertTriangle },
  };
  const { txt, Icon } = map[severity];
  return <Badge color={color} Icon={Icon} txt={txt} />;
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

function LoadCard({ I, onChange, onPreset }) {
  return (
    <Card title="Carga lineal base por fase" icon={<Activity size={15} />}>
      <div className="grid md:grid-cols-2 gap-x-6 gap-y-4 pt-2">
        <div className="space-y-4">
          {PHASES.map((p) => (
            <Slider key={p.key} phase={p} value={I[p.key]} onChange={(v) => onChange(p.key, v)} />
          ))}
        </div>
        <div className="md:border-l md:border-slate-800 md:pl-6">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-2">
            <RotateCcw size={11} /> Presets
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {PRESETS.map((pr) => (
              <button key={pr.label} onClick={() => onPreset(pr.v)}
                className="rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1.5 text-xs
                           text-slate-300 hover:border-slate-600 hover:bg-slate-800 transition-colors">
                {pr.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function CableCard({ cables, onChange }) {
  const rows = [...PHASES, { key: "n", label: "Neutro", color: NEUTRAL }];
  return (
    <Card title="Cableado por conductor" icon={<Cable size={15} />}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
        {rows.map((r) => {
          const R = cableResistance(cables[r.key].L, cables[r.key].A);
          return (
            <div key={r.key} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                  <span className="text-sm text-slate-300">{r.label}</span>
                </div>
                <span className="font-mono text-[10px] text-slate-500">{R.toFixed(3)} Ω</span>
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span>Largo</span><span className="font-mono">{cables[r.key].L} m</span>
                </div>
                <input type="range" min={1} max={100} step={1} value={cables[r.key].L}
                  onChange={(e) => onChange(r.key, "L", e.target.value)}
                  className="w-full cursor-pointer" style={{ accentColor: r.color }} />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[10px] text-slate-500">Sección</span>
                <select value={cables[r.key].A} onChange={(e) => onChange(r.key, "A", e.target.value)}
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-mono text-slate-200">
                  {CABLE_SECTIONS.map((s) => <option key={s} value={s}>{s} mm²</option>)}
                </select>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] text-slate-600 leading-relaxed">
        R = ρ·L/A (cobre). Más largo o menos sección ⇒ más resistencia ⇒ más caída de tensión bajo carga.
        El neutro afecta su propio desplazamiento. Mirá la pestaña <b className="text-slate-400">Tensión</b>.
      </p>
    </Card>
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
function VoltagePanel({ volt, faults }) {
  const rows = PHASES.map((p) => {
    const cut = faults[p.key];
    const V = volt.V[p.key];
    const pct = (V / V_NOM - 1) * 100;
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
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors
        ${active ? "text-slate-100 border-b-2" : "text-slate-500 border-b-2 border-transparent hover:text-slate-300"}`}
      style={active ? { borderColor: ACCENT } : undefined}>
      {icon}{label}
    </button>
  );
}

/* ===================== Vista: Diagrama Fasorial ===================== */

function PhasorView({ I, comp, nColor, vis, onToggle, neutralOpen }) {
  const VB = 340, C = VB / 2, R = 140, scale = R / I_MAX;
  const In = Math.hypot(comp.x, comp.y);

  const tip = (mag, angle) => ({
    x: C + mag * Math.cos(rad(angle)) * scale,
    y: C - mag * Math.sin(rad(angle)) * scale,
  });
  const nTip = { x: C + comp.x * scale, y: C - comp.y * scale };

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${VB} ${VB}`} className="w-full" style={{ maxWidth: 420 }}>
        {[10, 20, 30].map((r) => (
          <circle key={r} cx={C} cy={C} r={r * scale} fill="none" stroke="#1e293b" strokeWidth={1} />
        ))}
        {[10, 20, 30].map((r) => (
          <text key={`t${r}`} x={C + 3} y={C - r * scale + 11} fill="#475569"
            fontSize={9} fontFamily="monospace">{r}A</text>
        ))}
        <line x1={10} y1={C} x2={VB - 10} y2={C} stroke="#334155" strokeWidth={1} />
        <line x1={C} y1={10} x2={C} y2={VB - 10} stroke="#334155" strokeWidth={1} />

        {PHASES.map((p) => {
          const t = tip(I[p.key], p.angle);
          if (I[p.key] < 0.05 || !vis[p.key]) return null;
          return <Arrow key={p.key} x1={C} y1={C} x2={t.x} y2={t.y} color={p.color} width={2.5} />;
        })}

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

/* ===================== Vista: Formas de Onda (corriente) ===================== */

function WaveView({ spectra, In, nColor, vis, onToggle, neutralOpen }) {
  const W = 560, H = 260, padL = 40, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const cY = padT + plotH / 2;
  const N = 220;

  const { paths, nPath, yMax } = useMemo(() => {
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
    const toStr = (arr) => arr.map(([ms, v]) => `${x(ms)},${y(v)}`).join(" ");
    return {
      paths: PHASES.map((p) => ({ key: p.key, color: p.color, pts: toStr(raw[p.key]) })),
      nPath: toStr(raw.n),
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
        {ticks.map((a) => (
          <g key={a}>
            <line x1={padL} y1={y(a)} x2={W - padR} y2={y(a)}
              stroke={a === 0 ? "#334155" : "#1e293b"} strokeWidth={1} />
            <text x={padL - 5} y={y(a) + 3} textAnchor="end" fill="#475569"
              fontSize={9} fontFamily="monospace">{Math.round(a)}</text>
          </g>
        ))}
        {[0, 5, 10, 15, 20].map((ms) => (
          <g key={ms}>
            <line x1={x(ms)} y1={padT} x2={x(ms)} y2={H - padB} stroke="#1e293b" strokeWidth={1} />
            <text x={x(ms)} y={H - padB + 14} textAnchor="middle" fill="#475569"
              fontSize={9} fontFamily="monospace">{ms}ms</text>
          </g>
        ))}

        {paths.filter((p) => vis[p.key]).map((p) => (
          <polyline key={p.key} points={p.pts} fill="none" stroke={p.color}
            strokeWidth={2} strokeLinejoin="round" />
        ))}
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

/* ===================== Vista: Tensión (forma de onda) ===================== */

function VoltageView({ volt, spectra, R, Rn, faults, neutralOpen, vis, onToggle }) {
  const W = 560, H = 260, padL = 44, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const cY = padT + plotH / 2;
  const N = 240;

  const { paths, yMax } = useMemo(() => {
    const raw = { a: [], b: [], c: [] };
    let peak = V_NOM;

    // Caída armónica del neutro (compartida): -Rn · Σ corrientes armónicas (h>1).
    const neutralDrop = (th) => {
      if (neutralOpen || !Number.isFinite(Rn)) return 0;
      let inH = 0;
      for (const p of PHASES) {
        const spec = spectra[p.key] || {};
        for (const [h, m] of Object.entries(spec)) {
          const ho = Number(h);
          if (ho > 1) inH += m * Math.sin(ho * th + rad(ho * p.angle));
        }
      }
      return -Rn * inH;
    };

    for (let i = 0; i <= N; i++) {
      const ms = (i / N) * T_MS;
      const th = (ms / T_MS) * 2 * Math.PI;
      const vN = neutralDrop(th);
      for (const p of PHASES) {
        if (faults[p.key]) { raw[p.key].push([ms, null]); continue; } // fase cortada
        // fundamental (con caída) resuelta en `volt` + distorsión armónica del cable
        let u = volt.V[p.key] * Math.sin(th + volt.ang[p.key]) + vN;
        if (!neutralOpen && Number.isFinite(R[p.key])) {
          const spec = spectra[p.key] || {};
          let drop = 0;
          for (const [h, m] of Object.entries(spec)) {
            const ho = Number(h);
            if (ho > 1) drop += m * Math.sin(ho * th + rad(ho * p.angle));
          }
          u -= R[p.key] * drop;
        }
        raw[p.key].push([ms, u]);
        peak = Math.max(peak, Math.abs(u));
      }
    }
    const yMax = Math.ceil(peak / 50) * 50 || 50;
    const yS = (plotH / 2) / yMax;
    const x = (ms) => padL + (ms / T_MS) * plotW;
    const y = (v) => cY - v * yS;
    const toStr = (arr) =>
      arr.filter(([, v]) => v != null).map(([ms, v]) => `${x(ms)},${y(v)}`).join(" ");
    return {
      paths: PHASES.map((p) => ({ key: p.key, color: p.color, pts: toStr(raw[p.key]) })),
      yMax,
    };
  }, [volt, spectra, R, Rn, faults, neutralOpen]);

  const yS = (plotH / 2) / yMax;
  const y = (v) => cY - v * yS;
  const x = (ms) => padL + (ms / T_MS) * plotW;
  const ticks = [-yMax, 0, yMax];

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)}
              stroke={v === 0 ? "#334155" : "#1e293b"} strokeWidth={1} />
            <text x={padL - 5} y={y(v) + 3} textAnchor="end" fill="#475569"
              fontSize={9} fontFamily="monospace">{Math.round(v)}</text>
          </g>
        ))}
        {/* referencia ±V_NOM para ver la caída/sobretensión */}
        {[V_NOM, -V_NOM].map((v) => (
          <g key={`ref${v}`}>
            <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="#475569"
              strokeWidth={1} strokeDasharray="3 4" opacity={0.6} />
          </g>
        ))}
        <text x={W - padR} y={y(V_NOM) - 4} textAnchor="end" fill="#64748b"
          fontSize={8} fontFamily="monospace">{V_NOM}V nom</text>

        {[0, 5, 10, 15, 20].map((ms) => (
          <g key={ms}>
            <line x1={x(ms)} y1={padT} x2={x(ms)} y2={H - padB} stroke="#1e293b" strokeWidth={1} />
            <text x={x(ms)} y={H - padB + 14} textAnchor="middle" fill="#475569"
              fontSize={9} fontFamily="monospace">{ms}ms</text>
          </g>
        ))}

        {paths.filter((p) => vis[p.key] && !faults[p.key] && p.pts).map((p) => (
          <polyline key={p.key} points={p.pts} fill="none" stroke={p.color}
            strokeWidth={2} strokeLinejoin="round" />
        ))}
      </svg>

      <Legend nColor={NEUTRAL} vis={vis} onToggle={onToggle} noNeutral />
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] font-mono">
        {PHASES.map((p) => {
          if (faults[p.key]) return (
            <span key={p.key} className="text-slate-600">{p.label}: cortada</span>
          );
          const V = volt.V[p.key];
          const pct = (V / V_NOM - 1) * 100;
          const c = pct > 5 ? DANGER : pct < -5 ? "#eab308" : "#94a3b8";
          return (
            <span key={p.key} style={{ color: c }}>
              {p.label}: {Math.round(V)} V ({pct >= 0 ? "+" : ""}{pct.toFixed(0)}%)
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-[10px] text-slate-600 font-mono text-center max-w-md leading-relaxed">
        {neutralOpen
          ? "Neutro abierto: la tensión de carga se redistribuye según el desbalance (las fases livianas sobretensionan)."
          : "Tensión en la carga = nominal menos la caída por el cable (R·I). Subí el largo / bajá la sección para verla."}
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
                fill={b.triplen ? nColor : "#64748b"} fontSize={10} fontFamily="monospace">{b.h}ª</text>
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

function Legend({ nColor, note, dashed, vis, onToggle, neutralOpen, noNeutral }) {
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
        <span key={key} className={base} style={{ color: bold ? color : undefined }}>{content}</span>
      );
    return (
      <button key={key} onClick={() => onToggle(key)} title={on ? "Ocultar" : "Mostrar"}
        className={`${base} rounded-md px-2 py-1 transition-colors hover:bg-slate-800/70`}
        style={{ color: on ? (bold ? color : "#94a3b8") : "#64748b" }}>
        {content}
      </button>
    );
  };

  const neutralLabel = `Neutro${note ? ` · ${note}` : ""}`;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs">
      {PHASES.map((p) => item(p.key, p.label, p.color))}
      {noNeutral ? null : neutralOpen ? (
        <span className="flex items-center gap-1.5 font-medium text-slate-600">
          <Unplug size={12} /> {neutralLabel}
        </span>
      ) : (
        item("n", neutralLabel, nColor, { dash: dashed, bold: true })
      )}
    </div>
  );
}
