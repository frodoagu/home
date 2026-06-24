import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Minus, Plus, RotateCcw, MapPin, Palette, Loader2, Image } from "lucide-react";
import {
  INITIAL_SPAN,
  MIN_SPAN,
  MAX_INTERNAL,
  PREVIEW_MAX,
  PALETTES,
  PRESETS,
  computeRows,
  exportDims,
  paletteGradient,
  zoomView,
  panView,
} from "./mandelbrot";
import { useLanguage } from "../i18n/LanguageProvider";

/* -------------------------------------------------------------------------
 * Explorador del conjunto de Mandelbrot.
 * - Núcleo matemático (escape-time, coloreado suave, paletas) en `mandelbrot.js`.
 * - Render progresivo y cancelable: primero un preview de baja resolución
 *   (instantáneo) y luego refina a resolución completa por franjas, sin
 *   bloquear la UI ni al Raspberry.
 * - Interacción unificada mouse + touch (pointer events): clic/tap para acercar,
 *   arrastrar para desplazar, rueda para zoom; botones +/− para mobile.
 * ---------------------------------------------------------------------- */

export default function MandelbrotExplorer() {
  const { language } = useLanguage();
  const [view, setView] = useState({ cx: -0.5, cy: 0, span: INITIAL_SPAN });
  const [maxIter, setMaxIter] = useState(200);
  const [palIdx, setPalIdx] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [presetLabel, setPresetLabel] = useState("Vista completa");
  const [exportPct, setExportPct] = useState(null); // null = no exportando

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
    // Tamaño fijo (lado mayor ≈ PREVIEW_MAX), independiente de la resolución full.
    const q = Math.min(1, PREVIEW_MAX / Math.max(cw, ch));
    const rw = Math.max(1, Math.round(cw * q));
    const rh = Math.max(1, Math.round(ch * q));
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
    // Renderizar a la densidad real del display (cap a 2x) para que se vea
    // nítido en pantallas HiDPI; el cap por MAX_INTERNAL evita lienzos gigantes.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    const aspect = rect.height / rect.width;
    setView((v) => zoomView(v, px / rect.width, py / rect.height, aspect, factor));
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
    setView((v) => panView(v, dxp / rect.width, dyp / rect.height, rect.height / rect.width));
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

  // Renderiza la vista actual a 4K (offscreen, progresivo) y la abre como JPG en
  // una pestaña nueva. La pestaña se abre YA en el click (gesto del usuario) para
  // que no la bloquee el popup-blocker, y se navega al blob cuando termina.
  const exportHighRes = useCallback(() => {
    if (exportPct !== null) return; // ya hay una exportación en curso
    const { cw, ch } = sizeRef.current;
    const { view: v, maxIter: mi, palIdx: pi } = stateRef.current;
    const { W, H } = exportDims(cw, ch, 3840);

    const win = window.open("", "_blank");
    if (win) {
      win.document.write(
        `<title>Mandelbrot 4K</title><body style="margin:0;background:#020617;color:#e2e8f0;` +
          `font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh">` +
          `Renderizando ${W}×${H}…</body>`,
      );
    }

    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d");
    const img = octx.createImageData(W, H);
    const data = img.data;
    let py = 0;
    setExportPct(0);

    const step = () => {
      const start = performance.now();
      while (py < H && performance.now() - start < 24) {
        const next = Math.min(H, py + 4);
        computeRows(data, W, H, v.cx, v.cy, v.span, mi, PALETTES[pi], py, next);
        py = next;
      }
      setExportPct(Math.round((py / H) * 100));
      if (py < H) {
        requestAnimationFrame(step);
        return;
      }
      octx.putImageData(img, 0, 0);
      off.toBlob(
        (blob) => {
          const url = URL.createObjectURL(blob);
          if (win) win.location = url;
          else window.open(url, "_blank");
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          setExportPct(null);
        },
        "image/jpeg",
        0.92,
      );
    };
    requestAnimationFrame(step);
  }, [exportPct]);

  const zoomLevel = INITIAL_SPAN / view.span;
  const fmtZoom = zoomLevel >= 1000
    ? `${(zoomLevel / 1000).toFixed(1)}k×`
    : `${zoomLevel.toFixed(zoomLevel < 10 ? 1 : 0)}×`;
  const nearLimit = view.span <= MIN_SPAN * 50;

  const txt = language === "es"
    ? {
        title: "Mandelbrot · Explorador de fractales",
        subtitle: "z <- z^2 + c · coloreado suave · zoom hasta el limite del double",
        zoomIn: "Acercar",
        zoomOut: "Alejar",
        resetView: "Reiniciar vista",
        canvasHelp1: "Toca/clic para acercar · arrastra para mover · rueda para zoom ·",
        canvasHelp2: "shift+clic",
        canvasHelp3: "para alejar",
        rendering4k: "Renderizando 4K...",
        export4k: "Exportar vista en 4K (JPG)",
        spots: "Lugares",
        palette: "Paleta",
        detail: "Detalle",
        iterations: "Iteraciones",
        iterHint: "Mas iteraciones = mas detalle en lo profundo (y render mas lento).",
        coords: "Coordenadas",
        limitWarn: "Cerca del limite de precision (double): mas zoom se ve pixelado.",
      }
    : {
        title: "Mandelbrot · Fractal explorer",
        subtitle: "z <- z^2 + c · smooth coloring · zoom until double precision limits",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        resetView: "Reset view",
        canvasHelp1: "Tap/click to zoom in · drag to pan · wheel to zoom ·",
        canvasHelp2: "shift+click",
        canvasHelp3: "to zoom out",
        rendering4k: "Rendering 4K...",
        export4k: "Export current view in 4K (JPG)",
        spots: "Spots",
        palette: "Palette",
        detail: "Detail",
        iterations: "Iterations",
        iterHint: "More iterations = more detail in deep zones (and slower render).",
        coords: "Coordinates",
        limitWarn: "Near floating-point precision limits: extra zoom may look pixelated.",
      };

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
                {txt.title}
              </h1>
              <p className="font-mono text-xs text-slate-500">
                {txt.subtitle}
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
                  <IconBtn onClick={() => zoomCenter(0.5)} title={txt.zoomIn}><Plus size={18} /></IconBtn>
                  <IconBtn onClick={() => zoomCenter(2)} title={txt.zoomOut}><Minus size={18} /></IconBtn>
                  <IconBtn onClick={reset} title={txt.resetView}><RotateCcw size={16} /></IconBtn>
                </div>
              </div>
              <p className="border-t border-slate-800 px-3 py-2 text-center text-[11px] text-slate-500">
                {txt.canvasHelp1}
                <span className="text-slate-400"> {txt.canvasHelp2}</span> {txt.canvasHelp3}
              </p>
            </div>
          </section>

          {/* Controles */}
          <section className="space-y-4 lg:order-1 lg:col-span-4">
            <button
              onClick={exportHighRes}
              disabled={exportPct !== null}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-fuchsia-500/50 bg-fuchsia-500/15 px-4 py-3 text-sm font-medium text-fuchsia-200 transition-colors hover:bg-fuchsia-500/25 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {exportPct !== null ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {txt.rendering4k} {exportPct}%
                </>
              ) : (
                <>
                  <Image size={16} />
                  {txt.export4k}
                </>
              )}
            </button>

            <Card title={txt.spots} icon={<MapPin size={15} />}>
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

            <Card title={txt.palette} icon={<Palette size={15} />}>
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

            <Card title={txt.detail} icon={<Sparkles size={15} />}>
              <div className="pt-1">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-slate-300">{txt.iterations}</span>
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
                  {txt.iterHint}
                </p>
              </div>
            </Card>

            <Card title={txt.coords} icon={<MapPin size={15} />}>
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
                  {txt.limitWarn}
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
