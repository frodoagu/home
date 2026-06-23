import { useState, useMemo } from "react";
import { Zap, RotateCcw, Activity, Waves, AlertTriangle, CheckCircle2 } from "lucide-react";
import { I_MAX, F_HZ, T_MS, rad, neutralCurrent } from "./neutralCurrent";

/* -------------------------------------------------------------------------
 * Visualizador de corriente de neutro en sistema trifásico (3F + N)
 * - Fundamental puro, ángulos fijos 0/120/240, 50 Hz (T = 20 ms).
 * - Cálculo central en `neutralCurrent.js`; acá sólo se dibuja.
 * - El pico de in(t)=ia+ib+ic coincide con |In| (vistas consistentes).
 * ---------------------------------------------------------------------- */

const PHASES = [
  { key: "a", label: "Fase A", angle: 0,   color: "#ef4444" }, // roja
  { key: "b", label: "Fase B", angle: 120, color: "#92400e" }, // marrón
  { key: "c", label: "Fase C", angle: 240, color: "#eab308" }, // amarilla
];

// El neutro siempre se dibuja celeste (la severidad se indica con el texto/ícono).
const NEUTRAL = "#38bdf8";
const ACCENT = "#f59e0b"; // ámbar de la marca (icono y tabs activas)

const PRESETS = [
  { label: "Balanceado", v: { a: 10, b: 10, c: 10 } },
  { label: "3 / 7 / 7",  v: { a: 3,  b: 7,  c: 7  } },
  { label: "10 / 7 / 7", v: { a: 10, b: 7,  c: 7  } },
  { label: "Monofásico 30/0/0", v: { a: 30, b: 0, c: 0 } },
];

const fmt = (n) => n.toFixed(1);

export default function NeutralCurrentVisualizer() {
  const [I, setI] = useState({ a: 10, b: 10, c: 10 });
  const [tab, setTab] = useState("phasors");

  const set = (k, val) => setI((s) => ({ ...s, [k]: Number(val) }));

  /* ---- cálculo central ---- */
  const { In, comp, balanced, severity, sevColor } = useMemo(() => {
    const r = neutralCurrent(I);
    return { ...r, sevColor: NEUTRAL };
  }, [I]);

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
                {F_HZ} Hz · T = {T_MS} ms · fundamental · ∠ fijos 0/120/240°
              </p>
            </div>
          </div>
          <StatusBadge severity={severity} color={sevColor} />
        </header>

        {/* Métricas */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          {PHASES.map((p) => (
            <Metric key={p.key} label={p.label} value={I[p.key]} unit="A"
              color={p.color} sub={`∠ ${p.angle}°`} />
          ))}
          <div className="hidden" />
        </div>

        <div className="grid lg:grid-cols-12 gap-4">
          {/* Controles */}
          <section className="lg:col-span-4 space-y-4">
            <Card title="Control de carga por fase" icon={<Activity size={15} />}>
              <div className="space-y-5 pt-1">
                {PHASES.map((p) => (
                  <Slider key={p.key} phase={p} value={I[p.key]} onChange={(v) => set(p.key, v)} />
                ))}
              </div>
            </Card>

            <NeutralCard In={In} color={sevColor} balanced={balanced} />

            <Card title="Presets" icon={<RotateCcw size={15} />}>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {PRESETS.map((pr) => (
                  <button key={pr.label} onClick={() => setI(pr.v)}
                    className="rounded-md border border-slate-800 bg-slate-900 px-2 py-2 text-xs
                               text-slate-300 hover:border-slate-600 hover:bg-slate-800 transition-colors">
                    {pr.label}
                  </button>
                ))}
              </div>
            </Card>
          </section>

          {/* Visualización */}
          <section className="lg:col-span-8">
            <div className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
              <div className="flex border-b border-slate-800">
                <TabBtn active={tab === "phasors"} onClick={() => setTab("phasors")}
                  icon={<Activity size={14} />} label="Diagrama Fasorial" />
                <TabBtn active={tab === "waves"} onClick={() => setTab("waves")}
                  icon={<Waves size={14} />} label="Formas de Onda" />
              </div>
              <div className="p-4">
                {tab === "phasors"
                  ? <PhasorView I={I} comp={comp} In={In} nColor={sevColor} />
                  : <WaveView I={I} In={In} nColor={sevColor} />}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ===================== Subcomponentes UI ===================== */

function StatusBadge({ severity, color }) {
  const map = {
    ok:   { txt: "Balanceado",    Icon: CheckCircle2 },
    warn: { txt: "Desbalanceado", Icon: AlertTriangle },
    high: { txt: "Neutro cargado", Icon: AlertTriangle },
  };
  const { txt, Icon } = map[severity];
  return (
    <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium"
      style={{ borderColor: color + "55", color, backgroundColor: color + "14" }}>
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

function NeutralCard({ In, color, balanced }) {
  const pct = Math.min(100, (In / I_MAX) * 100);
  return (
    <div className="rounded-xl border bg-slate-900 p-4" style={{ borderColor: color + "55" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">Corriente de Neutro · I<sub>N</sub></span>
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-4xl font-mono font-bold tabular-nums" style={{ color }}>{fmt(In)}</span>
        <span className="text-lg text-slate-500 font-mono">A</span>
      </div>
      <div className="mt-3 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-150"
          style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <p className="mt-2 text-[10px] text-slate-600 font-mono leading-relaxed">
        √(Ia²+Ib²+Ic² − Ia·Ib − Ib·Ic − Ic·Ia) · solo fundamental, sin armónicos
      </p>
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

function PhasorView({ I, comp, In, nColor }) {
  const VB = 340, C = VB / 2, R = 140, scale = R / I_MAX;

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
          if (I[p.key] < 0.05) return null;
          return <Arrow key={p.key} x1={C} y1={C} x2={t.x} y2={t.y} color={p.color} width={2.5} />;
        })}

        {/* neutro (resultante) punteado */}
        {In >= 0.05 && (
          <Arrow x1={C} y1={C} x2={nTip.x} y2={nTip.y} color={nColor} width={3} dashed glow />
        )}
        <circle cx={C} cy={C} r={3} fill="#64748b" />
      </svg>

      <Legend In={In} nColor={nColor} />
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

function WaveView({ I, In, nColor }) {
  const W = 560, H = 260, padL = 40, padR = 16, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const cY = padT + plotH / 2;
  const yMax = 32;
  const yS = (plotH / 2) / yMax;
  const N = 180;

  const x = (ms) => padL + (ms / T_MS) * plotW;
  const y = (amp) => cY - amp * yS;

  // muestreo: ia/ib/ic = I·sin(θ+φ), in = suma. θ recorre 0..2π en 0..20ms
  const { paths, nPath } = useMemo(() => {
    const acc = { a: [], b: [], c: [], n: [] };
    for (let i = 0; i <= N; i++) {
      const ms = (i / N) * T_MS;
      const th = (ms / T_MS) * 2 * Math.PI;
      const ia = I.a * Math.sin(th + rad(0));
      const ib = I.b * Math.sin(th + rad(120));
      const ic = I.c * Math.sin(th + rad(240));
      const inst = ia + ib + ic;
      acc.a.push([x(ms), y(ia)]);
      acc.b.push([x(ms), y(ib)]);
      acc.c.push([x(ms), y(ic)]);
      acc.n.push([x(ms), y(inst)]);
    }
    const toStr = (arr) => arr.map((p) => p.join(",")).join(" ");
    return {
      paths: PHASES.map((p) => ({ color: p.color, pts: toStr(acc[p.key]) })),
      nPath: toStr(acc.n),
    };
  }, [I]);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* grilla horizontal (amperios) */}
        {[-30, -20, -10, 0, 10, 20, 30].map((a) => (
          <g key={a}>
            <line x1={padL} y1={y(a)} x2={W - padR} y2={y(a)}
              stroke={a === 0 ? "#334155" : "#1e293b"} strokeWidth={1} />
            <text x={padL - 5} y={y(a) + 3} textAnchor="end" fill="#475569"
              fontSize={9} fontFamily="monospace">{a}</text>
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

        {/* ondas de fase */}
        {paths.map((p, i) => (
          <polyline key={i} points={p.pts} fill="none" stroke={p.color}
            strokeWidth={1.5} opacity={0.85} strokeLinejoin="round" />
        ))}
        {/* onda del neutro */}
        <polyline points={nPath} fill="none" stroke={nColor} strokeWidth={2.5}
          strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px ${nColor})` }} />
      </svg>

      <Legend In={In} nColor={nColor} note={`pico I_N ≈ ${fmt(In)} A`} />
    </div>
  );
}

function Legend({ In, nColor, note }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs">
      {PHASES.map((p) => (
        <span key={p.key} className="flex items-center gap-1.5 text-slate-400">
          <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: p.color }} />
          {p.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5 font-medium" style={{ color: nColor }}>
        <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: nColor }} />
        Neutro {note ? `· ${note}` : `· ${fmt(In)} A`}
      </span>
    </div>
  );
}
