import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Minus, Plus, RotateCcw, MapPin, Palette, Loader2 } from "lucide-react";

/* -------------------------------------------------------------------------
 * Explorador del conjunto de Mandelbrot.
 * - Render por escape-time con coloreado suave (continuous / normalized iter).
 * - Paletas vibrantes tipo coseno (Inigo Quilez): color = a + b·cos(2π(c·t+d)).
 * - Render progresivo y cancelable: primero un preview de baja resolución
 *   (instantáneo) y luego refina a resolución completa por franjas, sin
 *   bloquear la UI ni al Raspberry.
 * - Interacción unificada mouse + touch (pointer events): clic/tap para acercar,
 *   arrastrar para desplazar, rueda para zoom; botones +/− para mobile.
 * ---------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const INITIAL_SPAN = 3.2; // ancho del plano complejo en la vista completa
const MIN_SPAN = 4e-14; // límite práctico del double (más allá: pixelado)
const MAX_SPAN = 4.5;
const ESCAPE2 = 1 << 16; // |z|² de escape (256²) — radio grande = degradé suave
const COLOR_CYCLE = 0.028; // iteraciones por ciclo de color ≈ 1/COLOR_CYCLE
const MAX_INTERNAL = 820; // tope del lado mayor del canvas (acota el costo)
const PREVIEW_Q = 0.32; // factor de resolución del preview

// Paletas (a, b, c, d) del esquema coseno de IQ. Vibrantes a propósito.
const PALETTES = [
  { name: "Arcoíris", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.33, 0.67] },
  { name: "Fuego", a: [0.5, 0.45, 0.4], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.0, 0.1, 0.2] },
  { name: "Océano", a: [0.4, 0.5, 0.5], b: [0.45, 0.5, 0.5], c: [1, 1, 1], d: [0.6, 0.55, 0.4] },
  { name: "Neón", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2.0, 1.0, 0.0], d: [0.5, 0.2, 0.25] },
  { name: "Áureo", a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.3, 0.2, 0.2] },
];

// Lugares emblemáticos del fractal. span chico = más zoom; iter sube en lo profundo.
const PRESETS = [
  { label: "Vista completa", cx: -0.5, cy: 0, span: 3.2, iter: 200 },
  { label: "Valle de caballitos", cx: -0.745428, cy: 0.113009, span: 0.016, iter: 600 },
  { label: "Valle de elefantes", cx: 0.2925, cy: 0.0149, span: 0.05, iter: 500 },
  { label: "Espiral triple", cx: -0.088, cy: 0.654, span: 0.028, iter: 600 },
  { label: "Mini-Mandelbrot", cx: -1.768778, cy: 0.001738, span: 0.006, iter: 800 },
  { label: "Tentáculos", cx: -0.748, cy: 0.1, span: 0.0017, iter: 900 },
  { label: "Espiral satélite", cx: -0.722, cy: 0.246, span: 0.018, iter: 700 },
  { label: "Misiurewicz", cx: -0.77568377, cy: 0.13646737, span: 0.012, iter: 800 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Color de un punto continuo `t` para una paleta — devuelve "r,g,b" (0–255).
function paletteCss(p, t) {
  const ch = (i) => clamp(Math.round(255 * (p.a[i] + p.b[i] * Math.cos(TAU * (p.c[i] * t + p.d[i])))), 0, 255);
  return `${ch(0)},${ch(1)},${ch(2)}`;
}
function paletteGradient(p) {
  const stops = [];
  for (let i = 0; i <= 8; i++) stops.push(`rgb(${paletteCss(p, i / 8)}) ${(i / 8) * 100}%`);
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

// Núcleo: rellena `data` (RGBA) para las filas [rowStart, rowEnd) sin asignar
// objetos por píxel (paleta inlineada) para no castigar al GC en el loop caliente.
function computeRows(data, rw, rh, cx, cy, span, maxIter, p, rowStart, rowEnd) {
  const dx = span / rw; // píxeles cuadrados → mismo paso en x e y
  const x0 = cx - span / 2 + dx / 2;
  const y0 = cy - (dx * rh) / 2 + dx / 2;
  const [a0, a1, a2] = p.a, [b0, b1, b2] = p.b, [c0, c1, c2] = p.c, [d0, d1, d2] = p.d;
  const invLn2 = 1 / Math.LN2;
  for (let py = rowStart; py < rowEnd; py++) {
    const im = y0 + py * dx;
    let o = py * rw * 4;
    for (let px = 0; px < rw; px++) {
      const re = x0 + px * dx;
      let zx = 0, zy = 0, zx2 = 0, zy2 = 0, n = 0;
      while (n < maxIter && zx2 + zy2 <= ESCAPE2) {
        zy = 2 * zx * zy + im;
        zx = zx2 - zy2 + re;
        zx2 = zx * zx;
        zy2 = zy * zy;
        n++;
      }
      if (n >= maxIter) {
        data[o++] = 8; data[o++] = 10; data[o++] = 20; data[o++] = 255; // interior
      } else {
        // iteración normalizada (coloreado suave)
        const logZn = Math.log(zx2 + zy2) * 0.5;
        const nu = Math.log(logZn * invLn2) * invLn2;
        const t = (n + 1 - nu) * COLOR_CYCLE;
        data[o++] = clamp((a0 + b0 * Math.cos(TAU * (c0 * t + d0))) * 255, 0, 255);
        data[o++] = clamp((a1 + b1 * Math.cos(TAU * (c1 * t + d1))) * 255, 0, 255);
        data[o++] = clamp((a2 + b2 * Math.cos(TAU * (c2 * t + d2))) * 255, 0, 255);
        data[o++] = 255;
      }
    }
  }
}

export default function MandelbrotExplorer() {
  const [view, setView] = useState({ cx: -0.5, cy: 0, span: INITIAL_SPAN });
  const [maxIter, setMaxIter] = useState(200);
  const [palIdx, setPalIdx] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [presetLabel, setPresetLabel] = useState("Vista completa");

  const canvasRef = useRef(null);
  const offRef = useRef(null); // canvas offscreen para el preview escalado
  const sizeRef = useRef({ cw: 1, ch: 1 }); // resolución interna actual
  const renderToken = useRef(0); // cancela renders full obsoletos
  // Espejo de los parámetros para los handlers de puntero sin recrear listeners.
  const stateRef = useRef({ view, maxIter, palIdx });
  stateRef.current = { view, maxIter, palIdx };

  if (!offRef.current && typeof document !== "undefined") {
    offRef.current = document.createElement("canvas");
  }

  // Preview de baja resolución, síncrono e instantáneo: da feedback inmediato.
  const renderPreview = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { cw, ch } = sizeRef.current;
    const { view: v, maxIter: mi, palIdx: pi } = stateRef.current;
    const rw = Math.max(1, Math.round(cw * PREVIEW_Q));
    const rh = Math.max(1, Math.round(ch * PREVIEW_Q));
    const off = offRef.current;
    off.width = rw;
    off.height = rh;
    const octx = off.getContext("2d");
    const img = octx.createImageData(rw, rh);
    computeRows(img.data, rw, rh, v.cx, v.cy, v.span, Math.min(mi, 140), PALETTES[pi], 0, rh);
    octx.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cw, ch);
  }, []);

  // Render completo, progresivo (por franjas con presupuesto de tiempo) y
  // cancelable. Dibuja encima del preview refinando de arriba hacia abajo.
  const renderFull = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const id = ++renderToken.current;
    const { cw, ch } = sizeRef.current;
    const { view: v, maxIter: mi, palIdx: pi } = stateRef.current;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(cw, ch);
    const data = img.data;
    let py = 0;
    setRendering(true);
    const chunk = () => {
      if (id !== renderToken.current) return; // cancelado por un render más nuevo
      const start = performance.now();
      const from = py;
      while (py < ch && performance.now() - start < 14) {
        const next = Math.min(ch, py + 8);
        computeRows(data, cw, ch, v.cx, v.cy, v.span, mi, PALETTES[pi], py, next);
        py = next;
      }
      // Sólo blitea las filas recién calculadas (deja el preview debajo del resto).
      ctx.putImageData(img, 0, 0, 0, from, cw, py - from);
      if (py < ch) requestAnimationFrame(chunk);
      else setRendering(false);
    };
    requestAnimationFrame(chunk);
  }, []);

  // Ajusta la resolución interna del canvas a su tamaño en pantalla (con tope).
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let cw = Math.round(rect.width * dpr);
    let ch = Math.round(rect.height * dpr);
    const longest = Math.max(cw, ch);
    if (longest > MAX_INTERNAL) {
      const k = MAX_INTERNAL / longest;
      cw = Math.round(cw * k);
      ch = Math.round(ch * k);
    }
    if (cw === sizeRef.current.cw && ch === sizeRef.current.ch) return false;
    sizeRef.current = { cw, ch };
    canvas.width = cw;
    canvas.height = ch;
    return true;
  }, []);

  // Re-render ante cualquier cambio de parámetros (vista, iteraciones, paleta).
  useEffect(() => {
    renderPreview();
    renderFull();
  }, [view, maxIter, palIdx, renderPreview, renderFull]);

  // Tamaño inicial + ResizeObserver.
  useEffect(() => {
    resize();
    renderPreview();
    renderFull();
    const ro = new ResizeObserver(() => {
      if (resize()) {
        renderPreview();
        renderFull();
      }
    });
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom manteniendo fijo el punto (px, py) en coordenadas de pantalla.
  const zoomAt = useCallback((px, py, factor) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    setView((v) => {
      const aspect = rect.height / rect.width;
      const reAt = v.cx + (px / rect.width - 0.5) * v.span;
      const imAt = v.cy + (py / rect.height - 0.5) * v.span * aspect;
      const nspan = clamp(v.span * factor, MIN_SPAN, MAX_SPAN);
      return {
        cx: reAt - (px / rect.width - 0.5) * nspan,
        cy: imAt - (py / rect.height - 0.5) * nspan * aspect,
      };
    });
  }, []);

  // Rueda del mouse: zoom hacia el cursor (listener nativo para poder cancelar el scroll).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY > 0 ? 1.22 : 1 / 1.22);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Puntero: arrastrar = desplazar; clic/tap corto = acercar (shift/alt = alejar).
  const drag = useRef(null);
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dxp = e.clientX - d.x;
    const dyp = e.clientY - d.y;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
    if (!d.moved) return;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => {
      const aspect = rect.height / rect.width;
      return {
        cx: v.cx - (dxp / rect.width) * v.span,
        cy: v.cy - (dyp / rect.height) * v.span * aspect,
      };
    });
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      const rect = e.currentTarget.getBoundingClientRect();
      const out = e.shiftKey || e.altKey;
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, out ? 2 : 0.5);
    }
  };

  const applyPreset = (pr) => {
    setPresetLabel(pr.label);
    setMaxIter(pr.iter);
    setView({ cx: pr.cx, cy: pr.cy, span: pr.span });
  };
  const reset = () => applyPreset(PRESETS[0]);
  const zoomCenter = (factor) => {
    const c = canvasRef.current?.getBoundingClientRect();
    if (c) zoomAt(c.width / 2, c.height / 2, factor);
  };

  const zoomLevel = INITIAL_SPAN / view.span;
  const fmtZoom = zoomLevel >= 1000
    ? `${(zoomLevel / 1000).toFixed(1)}k×`
    : `${zoomLevel.toFixed(zoomLevel < 10 ? 1 : 0)}×`;
  const nearLimit = view.span <= MIN_SPAN * 50;

  return (
    <div className="w-full min-h-full bg-slate-950 text-slate-100 p-4 sm:p-6 font-sans">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-2">
              <Sparkles size={20} style={{ color: "#c026d3" }} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
                Mandelbrot · Explorador de fractales
              </h1>
              <p className="font-mono text-xs text-slate-500">
                z ← z² + c · coloreado suave · zoom hasta el límite del double
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-300 sm:flex">
            {rendering ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {fmtZoom}
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-12">
          {/* Lienzo (primero en mobile, a la derecha en desktop) */}
          <section className="lg:order-2 lg:col-span-8">
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
              <div className="relative h-[58vh] w-full sm:h-[66vh]">
                <canvas
                  ref={canvasRef}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  className="block h-full w-full cursor-crosshair select-none"
                  style={{ touchAction: "none" }}
                />
                {/* Controles flotantes de zoom (cómodos en mobile) */}
                <div className="absolute bottom-3 right-3 flex flex-col gap-2">
                  <IconBtn onClick={() => zoomCenter(0.5)} title="Acercar"><Plus size={18} /></IconBtn>
                  <IconBtn onClick={() => zoomCenter(2)} title="Alejar"><Minus size={18} /></IconBtn>
                  <IconBtn onClick={reset} title="Reiniciar vista"><RotateCcw size={16} /></IconBtn>
                </div>
              </div>
              <p className="border-t border-slate-800 px-3 py-2 text-center text-[11px] text-slate-500">
                Tocá/clic para acercar · arrastrá para mover · rueda para zoom ·
                <span className="text-slate-400"> shift+clic</span> para alejar
              </p>
            </div>
          </section>

          {/* Controles */}
          <section className="space-y-4 lg:order-1 lg:col-span-4">
            <Card title="Lugares" icon={<MapPin size={15} />}>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {PRESETS.map((pr) => {
                  const active = pr.label === presetLabel;
                  return (
                    <button
                      key={pr.label}
                      onClick={() => applyPreset(pr)}
                      className={`rounded-md border px-2 py-2 text-xs transition-colors ${
                        active
                          ? "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-200"
                          : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600 hover:bg-slate-800"
                      }`}
                    >
                      {pr.label}
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card title="Paleta" icon={<Palette size={15} />}>
              <div className="space-y-2 pt-1">
                {PALETTES.map((p, i) => (
                  <button
                    key={p.name}
                    onClick={() => setPalIdx(i)}
                    className={`flex w-full items-center gap-3 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                      i === palIdx
                        ? "border-fuchsia-500/50 text-slate-100"
                        : "border-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                    }`}
                  >
                    <span
                      className="h-4 w-16 flex-none rounded"
                      style={{ background: paletteGradient(p) }}
                    />
                    {p.name}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="Detalle" icon={<Sparkles size={15} />}>
              <div className="pt-1">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-slate-300">Iteraciones</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-fuchsia-300">
                    {maxIter}
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={1200}
                  step={50}
                  value={maxIter}
                  onChange={(e) => setMaxIter(Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: "#c026d3" }}
                />
                <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                  Más iteraciones = más detalle en lo profundo (y render más lento).
                </p>
              </div>
            </Card>

            <Card title="Coordenadas" icon={<MapPin size={15} />}>
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 pt-1 font-mono text-[11px]">
                <dt className="text-slate-500">re</dt>
                <dd className="truncate text-right text-slate-300">{view.cx.toPrecision(10)}</dd>
                <dt className="text-slate-500">im</dt>
                <dd className="truncate text-right text-slate-300">{view.cy.toPrecision(10)}</dd>
                <dt className="text-slate-500">zoom</dt>
                <dd className="text-right text-fuchsia-300">{fmtZoom}</dd>
              </dl>
              {nearLimit && (
                <p className="mt-2 text-[10px] leading-relaxed text-amber-400/80">
                  Cerca del límite de precisión (double): más zoom se ve pixelado.
                </p>
              )}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}

/* ===================== Subcomponentes UI ===================== */

function Card({ title, icon, children }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        {icon}
        <span className="uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  );
}

function IconBtn({ onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900/80 text-slate-200 backdrop-blur transition-colors hover:border-fuchsia-500/50 hover:text-fuchsia-300"
    >
      {children}
    </button>
  );
}
