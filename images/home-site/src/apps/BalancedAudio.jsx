import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cable, Play, Square, Magnet, Smartphone, Lightbulb, Unplug, Waves, BarChart3, BookOpen,
  Headphones, ArrowLeftRight, Ruler, SlidersHorizontal, Activity, AlertTriangle, CheckCircle2, Volume2,
} from "lucide-react";
import {
  MODES, LEVELS, SIGNALS, NOISES, KEYS, DEFAULTS, LOOP_S, MAINS_HZ, TONE_HZ,
  isDifferential, usesPair, lineModel, trace, vizWaves, snrDb, noiseRms, monitorGains,
  renderSignal, renderNoise, waveRms, dbu,
} from "./balancedAudio";
import { localizeText, pick, useLanguage } from "../i18n/LanguageProvider";

/* -------------------------------------------------------------------------
 * Balanced audio lines: why a differential receiver ignores what both legs
 * pick up alike, and what is left when the legs don't match. The model lives
 * in `balancedAudio.js`; this file draws it and plays it back.
 * ---------------------------------------------------------------------- */

const ACCENT = "#22d3ee";
const HOT = "#ef4444";
const COLD = "#3b82f6";
const SHIELD = "#94a3b8";
const OUT = "#34d399";
const DANGER = "#f43f5e";

const NOISE_ICONS = { hum: Magnet, dimmer: Lightbulb, phone: Smartphone, ground: Unplug };

const snrColor = (db) => (db >= 60 ? "#34d399" : db >= 30 ? "#f59e0b" : DANGER);

function fmtVolts(v) {
  const a = Math.abs(v);
  if (a === 0) return "0 V";
  if (a < 1e-3) return `${(v * 1e6).toFixed(a < 1e-4 ? 1 : 0)} µV`;
  if (a < 1) return `${(v * 1e3).toFixed(a < 0.01 ? 2 : a < 0.1 ? 1 : 0)} mV`;
  return `${v.toFixed(2)} V`;
}

const fmtDb = (db) => (db === Infinity ? "∞" : db > 140 ? "> 140" : String(Math.round(db) || 0));

// Smallest 1-2-5 step that holds `v`.
function niceScale(v) {
  if (!(v > 0)) return 1e-3;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const peakOf = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/* ---- playback: one looped buffer per waveform, each through its gain ---- */

function useMonitor(signalKind, gains, volume) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);

  const play = (key, data) => {
    const m = ref.current;
    const buffer = m.ctx.createBuffer(1, data.length, m.ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    const src = m.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(m.gains[key]);
    const now = m.ctx.currentTime;
    const at = Math.max(now, m.t0);
    src.start(at, (at - m.t0) % LOOP_S);
    m.sources[key]?.stop(at);
    m.sources[key] = src;
  };

  const start = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || ref.current) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const nodes = {};
    for (const k of KEYS) {
      nodes[k] = ctx.createGain();
      nodes[k].gain.value = gains[k];
      nodes[k].connect(master);
    }
    ref.current = { ctx, master, gains: nodes, sources: {}, t0: ctx.currentTime + 0.05 };
    for (const n of NOISES) play(n.key, renderNoise(n.key, ctx.sampleRate));
    play("signal", renderSignal(signalKind, ctx.sampleRate));
    master.gain.setTargetAtTime(volume, ref.current.t0, 0.03);
    setPlaying(true);
  };

  const stop = () => {
    const m = ref.current;
    if (!m) return;
    ref.current = null;
    m.master.gain.setTargetAtTime(0, m.ctx.currentTime, 0.02);
    setTimeout(() => m.ctx.close(), 150);
    setPlaying(false);
  };

  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    for (const k of KEYS) m.gains[k].gain.setTargetAtTime(gains[k], m.ctx.currentTime, 0.015);
  }, [gains]);

  useEffect(() => {
    const m = ref.current;
    if (m) m.master.gain.setTargetAtTime(volume, m.ctx.currentTime, 0.03);
  }, [volume]);

  useEffect(() => {
    if (ref.current) play("signal", renderSignal(signalKind, ref.current.ctx.sampleRate));
  }, [signalKind]);

  useEffect(() => () => ref.current?.ctx.close(), []);

  return { playing, start, stop };
}

export default function BalancedAudio() {
  const { language } = useLanguage();
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);

  const [mode, setMode] = useState(DEFAULTS.mode);
  const [levelKey, setLevelKey] = useState("mic");
  const [signal, setSignal] = useState("tone");
  const [length, setLength] = useState(DEFAULTS.length);
  const [shield, setShield] = useState(DEFAULTS.shield);
  const [twisted, setTwisted] = useState(DEFAULTS.twisted);
  const [imbalancePct, setImbalancePct] = useState(DEFAULTS.imbalance * 100);
  const [cmrr, setCmrr] = useState(DEFAULTS.cmrr);
  const [noise, setNoise] = useState(DEFAULTS.noise);
  const [faults, setFaults] = useState(DEFAULTS.faults);
  const [volume, setVolume] = useState(0.5);

  const level = LEVELS.find((l) => l.key === levelKey).volts;
  const diff = isDifferential(mode);
  const settings = useMemo(
    () => ({
      mode, level, length, shield, twisted, imbalance: imbalancePct / 100, cmrr, noise,
      faults: isDifferential(mode) ? faults : DEFAULTS.faults,
    }),
    [mode, level, length, shield, twisted, imbalancePct, cmrr, noise, faults],
  );

  const model = useMemo(() => lineModel(settings), [settings]);
  const waves = useMemo(() => vizWaves(signal), [signal]);
  const traces = useMemo(() => ({
    hot: trace(model.hot, waves),
    cold: model.cold ? trace(model.cold, waves) : new Float32Array(waves.signal.length),
    out: trace(model.out, waves),
    ideal: trace(model.ideal, waves),
  }), [model, waves]);
  const snr = snrDb(model.out);
  const comparison = useMemo(
    () => MODES.map((m) => ({ ...m, snr: snrDb(lineModel({ ...settings, mode: m.key, faults: DEFAULTS.faults }).out) })),
    [settings],
  );
  const gains = useMemo(() => monitorGains(model.out), [model]);
  const monitor = useMonitor(signal, gains, volume);

  const faulty = diff && (faults.coldOpen || faults.swapped);
  const abMode = mode === "unbalanced" ? "balanced" : "unbalanced";

  return (
    <div className="w-full min-h-full bg-slate-950 text-slate-100 p-4 sm:p-6 font-sans">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900 p-2">
              <Cable size={20} style={{ color: ACCENT }} />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight">
                {t("Audio balanceado · Cómo un cable se saca el ruido de encima",
                  "Balanced audio · How a cable shrugs off noise",
                  "Áudio balanceado · Como um cabo se livra do ruído",
                  "Audio symétrique · Comment un câble se débarrasse du bruit")}
              </h1>
              <p className="text-xs text-slate-500 font-mono">
                {t("señal diferencial · rechazo de modo común",
                  "differential signal · common-mode rejection",
                  "sinal diferencial · rejeição de modo comum",
                  "signal différentiel · réjection de mode commun")}
              </p>
            </div>
          </div>
          <div role="status" className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium font-mono"
            style={{ borderColor: snrColor(snr) + "66", color: snrColor(snr), backgroundColor: snrColor(snr) + "14" }}>
            {snr >= 60 ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            SNR {fmtDb(snr)} dB
          </div>
        </header>

        <ModePicker mode={mode} onChange={setMode} language={language} />

        <div className="grid lg:grid-cols-5 gap-4">
          <Card className="lg:col-span-3" title={t("El circuito", "The circuit", "O circuito", "Le circuit")} icon={<Cable size={15} />}>
            <Schematic mode={mode} shield={shield} twisted={twisted} noise={noise}
              faults={diff ? faults : DEFAULTS.faults} language={language} />
            <ModeNote mode={mode} faults={diff ? faults : DEFAULTS.faults} language={language} />
          </Card>
          <Card className="lg:col-span-2" title={t("Mismo cable, cada conexión", "Same cable, every hookup", "Mesmo cabo, cada ligação", "Même câble, chaque branchement")}
            icon={<BarChart3 size={15} />}>
            <Comparison rows={comparison} mode={mode} onPick={setMode} faulty={faulty} snr={snr} language={language} />
          </Card>
        </div>

        <Card title={t("Osciloscopio · un ciclo de red", "Scope · one mains cycle", "Osciloscópio · um ciclo da rede", "Oscilloscope · un cycle secteur")}
          icon={<Waves size={15} />}>
          <Scopes mode={mode} model={model} traces={traces} language={language} />
        </Card>

        <div className="grid lg:grid-cols-2 gap-4">
          <Card title={t("Fuentes de ruido", "Noise sources", "Fontes de ruído", "Sources de bruit")} icon={<Activity size={15} />}>
            <NoiseControls noise={noise} onChange={setNoise} language={language} />
          </Card>
          <div className="flex flex-col gap-4">
            <Card title={t("Escuchar la salida", "Listen to the output", "Ouvir a saída", "Écouter la sortie")} icon={<Headphones size={15} />}>
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button onClick={monitor.playing ? monitor.stop : monitor.start}
                  className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors"
                  style={{ borderColor: ACCENT + "88", color: ACCENT, backgroundColor: ACCENT + (monitor.playing ? "26" : "10") }}>
                  {monitor.playing ? <Square size={15} /> : <Play size={15} />}
                  {monitor.playing ? t("Parar", "Stop", "Parar", "Arrêter") : t("Escuchar", "Listen", "Ouvir", "Écouter")}
                </button>
                <button onClick={() => setMode(abMode)}
                  className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-300 hover:border-slate-500">
                  <ArrowLeftRight size={14} />
                  A/B → {localizeText(MODES.find((m) => m.key === abMode).label, language)}
                </button>
                <label className="flex flex-1 min-w-[140px] items-center gap-2 text-xs text-slate-500">
                  <Volume2 size={14} />
                  <input type="range" min={0} max={1} step={0.01} value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-full cursor-pointer" style={{ accentColor: ACCENT }}
                    aria-label={t("Volumen", "Volume", "Volume", "Volume")} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {SIGNALS.map((s) => (
                  <Chip key={s.key} active={signal === s.key} onClick={() => setSignal(s.key)}>
                    {localizeText(s.label, language)}
                  </Chip>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
                {t("Un preamp lleva la señal a nivel nominal y el ruido sube con ella: lo que escuchás es la relación señal/ruido. Cambiá de conexión mientras suena. Ojo con el volumen en micrófono + no balanceado.",
                  "A preamp brings the signal up to nominal level and the noise rises with it: what you hear is the signal-to-noise ratio. Switch hookups while it plays. Mind the volume on microphone + unbalanced.",
                  "Um pré-amplificador leva o sinal ao nível nominal e o ruído sobe junto: o que você ouve é a relação sinal/ruído. Troque a ligação enquanto toca. Cuidado com o volume em microfone + não balanceado.",
                  "Un préampli amène le signal au niveau nominal et le bruit monte avec lui : ce que tu entends, c'est le rapport signal/bruit. Change de branchement pendant la lecture. Attention au volume en micro + asymétrique.")}
              </p>
            </Card>
            <Card title={t("Señal", "Signal", "Sinal", "Signal")} icon={<SlidersHorizontal size={15} />}>
              <div className="grid grid-cols-3 gap-2 pt-2">
                {LEVELS.map((l) => (
                  <button key={l.key} onClick={() => setLevelKey(l.key)}
                    className={`rounded-md border px-2 py-2 text-left text-xs transition-colors ${
                      levelKey === l.key ? "border-cyan-400 bg-cyan-400/10 text-cyan-200" : "border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-600"}`}>
                    {localizeText(l.label, language)}
                    <span className="block font-mono text-[10px] text-slate-500">
                      {fmtVolts(l.volts)} · {dbu(l.volts).toFixed(0)} dBu
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                {t("El ruido que se cuela es el mismo en milivolts: contra los pocos milivolts de un micrófono pesa 50 dB más que contra una señal de línea.",
                  "The noise that sneaks in is the same few millivolts: against a microphone's millivolts it weighs 50 dB more than against a line signal.",
                  "O ruído que entra é o mesmo em milivolts: contra os poucos milivolts de um microfone pesa 50 dB a mais do que contra um sinal de linha.",
                  "Le bruit qui s'infiltre fait les mêmes quelques millivolts : face aux millivolts d'un micro, il pèse 50 dB de plus que face à un signal ligne.")}
              </p>
            </Card>
            <Card className="flex-1" title={t("Fallas del cable", "Cable faults", "Falhas do cabo", "Défauts du câble")} icon={<Unplug size={15} />}>
              <FaultControls faults={faults} onChange={setFaults} enabled={diff} language={language} />
            </Card>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <Card title={t("Cable y receptor", "Cable and receiver", "Cabo e receptor", "Câble et récepteur")} icon={<Ruler size={15} />}>
            <div className="space-y-3 pt-2">
              <Range label={t("Largo", "Length", "Comprimento", "Longueur")} value={length} min={1} max={100} step={1}
                display={`${length} m`} onChange={setLength} />
              <div className="flex flex-wrap gap-2">
                <Toggle on={shield} onClick={() => setShield(!shield)}
                  label={t("Malla (blindaje)", "Shield", "Malha (blindagem)", "Blindage")} />
                <Toggle on={twisted && usesPair(mode)} disabled={!usesPair(mode)} onClick={() => setTwisted(!twisted)}
                  label={t("Par trenzado", "Twisted pair", "Par trançado", "Paire torsadée")}
                  title={usesPair(mode) ? undefined : t("Un TS tiene un solo conductor dentro de la malla", "A TS cable has a single conductor inside the shield", "Um TS tem um só condutor dentro da malha", "Un câble TS n'a qu'un conducteur dans le blindage")} />
              </div>
              <Range label={t("Desbalance de impedancias", "Impedance mismatch", "Desbalanceamento de impedâncias", "Déséquilibre d'impédances")}
                value={imbalancePct} min={0} max={10} step={0.1} display={`${imbalancePct.toFixed(1)} %`}
                onChange={setImbalancePct} disabled={!diff} />
              <Range label={t("CMRR del receptor", "Receiver CMRR", "CMRR do receptor", "TRMC du récepteur")}
                value={cmrr} min={20} max={100} step={1} display={`${cmrr} dB`} onChange={setCmrr} disabled={!diff} />
              <p className="text-[11px] text-slate-500 leading-relaxed">
                {diff
                  ? t("Lo que llega igual a las dos patas se resta. Lo que sobrevive es lo que llegó DISTINTO: el desbalance (tolerancias, un conector flojo, salidas distintas) y el límite del propio receptor.",
                    "Whatever reaches both legs alike subtracts away. What survives is what arrived DIFFERENT: the mismatch (tolerances, a loose connector, unlike outputs) and the receiver's own limit.",
                    "O que chega igual às duas pernas se subtrai. O que sobrevive é o que chegou DIFERENTE: o desbalanceamento (tolerâncias, um conector frouxo, saídas diferentes) e o limite do próprio receptor.",
                    "Ce qui arrive pareil sur les deux pattes se soustrait. Ce qui survit, c'est ce qui est arrivé DIFFÉREMMENT : le déséquilibre (tolérances, un connecteur desserré, sorties dissemblables) et la limite du récepteur.")
                  : t("Una entrada no balanceada mide la punta contra su propia masa: todo lo que se induce entre las dos llega a la salida.",
                    "An unbalanced input measures the tip against its own ground: everything induced between them reaches the output.",
                    "Uma entrada não balanceada mede a ponta contra sua própria terra: tudo o que se induz entre as duas chega à saída.",
                    "Une entrée asymétrique mesure la pointe par rapport à sa propre masse : tout ce qui s'induit entre les deux arrive en sortie.")}
              </p>
            </div>
          </Card>
          <Card title={t("Qué se cuela, fuente por fuente", "What gets through, source by source", "O que passa, fonte por fonte", "Ce qui passe, source par source")}
            icon={<BarChart3 size={15} />}>
            <SourceTable model={model} noise={noise} language={language} />
          </Card>
        </div>

        <Guide language={language} />
      </div>
    </div>
  );
}

/* ===================== building blocks ===================== */

function Card({ title, icon, children, className = "" }) {
  return (
    <div className={`flex min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900 p-4 ${className}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        {icon}<span className="uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active ? "border-cyan-400 bg-cyan-400/10 text-cyan-200" : "border-slate-800 bg-slate-950/50 text-slate-400 hover:border-slate-600"}`}>
      {children}
    </button>
  );
}

function Toggle({ on, onClick, label, disabled, title }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-pressed={on}
      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${
        on ? "border-cyan-400 bg-cyan-400/10 text-cyan-200" : "border-slate-800 bg-slate-950/50 text-slate-400 hover:border-slate-600"}`}>
      <span className={`h-2 w-2 rounded-full ${on ? "bg-cyan-300" : "bg-slate-700"}`} />
      {label}
    </button>
  );
}

function Range({ label, value, min, max, step, display, onChange, disabled, color = ACCENT }) {
  return (
    <label className={`block ${disabled ? "opacity-40" : ""}`}>
      <span className="flex items-center justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono tabular-nums" style={{ color }}>{display}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer disabled:cursor-not-allowed" style={{ accentColor: color }} />
    </label>
  );
}

function ModePicker({ mode, onChange, language }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {MODES.map((m) => {
        const active = mode === m.key;
        return (
          <button key={m.key} onClick={() => onChange(m.key)} aria-pressed={active}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active ? "border-cyan-400 bg-cyan-400/10" : "border-slate-800 bg-slate-900 hover:border-slate-600"}`}>
            <span className={`block text-sm font-medium ${active ? "text-cyan-200" : "text-slate-200"}`}>
              {localizeText(m.label, language)}
            </span>
            <span className="block font-mono text-[10px] text-slate-500">{m.connector}</span>
          </button>
        );
      })}
    </div>
  );
}

function ModeNote({ mode, faults, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const notes = {
    unbalanced: t("Un conductor lleva la señal y la malla hace de retorno Y de masa. Todo lo que aparezca entre los dos, incluida la caída del lazo de masa sobre la malla, entra como si fuera señal.",
      "One conductor carries the signal and the shield is both the return AND ground. Anything that shows up between them, including the ground loop's drop along the shield, comes in as if it were signal.",
      "Um condutor leva o sinal e a malha é o retorno E a terra. Tudo o que aparecer entre os dois, incluída a queda do loop de terra na malha, entra como se fosse sinal.",
      "Un conducteur porte le signal et le blindage sert de retour ET de masse. Tout ce qui apparaît entre les deux, y compris la chute de la boucle de masse sur le blindage, entre comme si c'était du signal."),
    balanced: t("La señal va por el pin 2 y su copia invertida por el 3. El receptor resta 2 − 3: la señal se duplica (+6 dB) y lo que llegó igual a las dos patas se cancela.",
      "The signal rides pin 2 and its inverted copy pin 3. The receiver takes 2 − 3: the signal doubles (+6 dB) and whatever reached both legs alike cancels.",
      "O sinal vai pelo pino 2 e sua cópia invertida pelo 3. O receptor subtrai 2 − 3: o sinal dobra (+6 dB) e o que chegou igual às duas pernas se cancela.",
      "Le signal passe par la broche 2 et sa copie inversée par la 3. Le récepteur fait 2 − 3 : le signal double (+6 dB) et ce qui est arrivé pareil sur les deux pattes s'annule."),
    impedance: t("El pin 3 no lleva señal, sólo la misma impedancia que el 2. Alcanza: el ruido se induce igual en las dos patas y se cancela igual. Se pierden los 6 dB, no el rechazo.",
      "Pin 3 carries no signal, just the same impedance as pin 2. That's enough: noise is induced alike on both legs and cancels just the same. You lose the 6 dB, not the rejection.",
      "O pino 3 não leva sinal, só a mesma impedância do 2. Basta: o ruído se induz igual nas duas pernas e se cancela igual. Perdem-se os 6 dB, não a rejeição.",
      "La broche 3 ne porte pas de signal, juste la même impédance que la 2. Ça suffit : le bruit s'induit pareil sur les deux pattes et s'annule pareil. On perd les 6 dB, pas la réjection."),
    mixed: t("Un plug TS en una salida balanceada pone el pin 3 (anillo) a masa. Suena, pero vuelve a ser una línea no balanceada: menos 6 dB y sin rechazo.",
      "A TS plug in a balanced output grounds pin 3 (the ring). It works, but it's an unbalanced line again: 6 dB down and no rejection.",
      "Um plugue TS numa saída balanceada aterra o pino 3 (anel). Funciona, mas volta a ser uma linha não balanceada: 6 dB a menos e sem rejeição.",
      "Une fiche TS sur une sortie symétrique met la broche 3 (bague) à la masse. Ça marche, mais c'est de nouveau une ligne asymétrique : 6 dB de moins et aucune réjection."),
  };
  return (
    <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
      {notes[mode]}
      {faults.coldOpen && (
        <span className="block mt-1" style={{ color: DANGER }}>
          {t("Pata fría cortada: el receptor ve el pin 3 en 0 V y todo el ruido del pin 2 pasa.",
            "Cold leg open: the receiver sees pin 3 at 0 V and all the noise on pin 2 gets through.",
            "Perna fria cortada: o receptor vê o pino 3 em 0 V e todo o ruído do pino 2 passa.",
            "Patte froide coupée : le récepteur voit la broche 3 à 0 V et tout le bruit de la broche 2 passe.")}
        </span>
      )}
      {faults.swapped && (
        <span className="block mt-1" style={{ color: DANGER }}>
          {t("Pines 2 y 3 cruzados: mismo rechazo, polaridad invertida.",
            "Pins 2 and 3 swapped: same rejection, inverted polarity.",
            "Pinos 2 e 3 trocados: mesma rejeição, polaridade invertida.",
            "Broches 2 et 3 inversées : même réjection, polarité inversée.")}
        </span>
      )}
    </p>
  );
}

/* ===================== schematic ===================== */

const X0 = 118, X1 = 500, Y_HOT = 100, Y_COLD = 140, MID = 120, TWIST = 9; // twists along the cable
const BREAK = [300, 326];

function wire(sign, twisted, from = X0, to = X1) {
  if (!twisted) return `M${from},${MID + sign * 20} L${to},${MID + sign * 20}`;
  const pts = [];
  for (let x = from; x <= to; x += 3) {
    pts.push(`${x},${(MID + sign * 20 * Math.cos((Math.PI * 2 * TWIST * (x - X0)) / (X1 - X0))).toFixed(1)}`);
  }
  return `M${pts.join(" L")}`;
}

function Ground({ x, y }) {
  return (
    <g stroke={SHIELD} strokeWidth={1.5}>
      <line x1={x - 9} y1={y} x2={x + 9} y2={y} />
      <line x1={x - 6} y1={y + 4} x2={x + 6} y2={y + 4} />
      <line x1={x - 3} y1={y + 8} x2={x + 3} y2={y + 8} />
    </g>
  );
}

function Zigzag({ x, y0, y1, color, faded }) {
  const pts = [`${x},${y0}`];
  let side = 1;
  for (let y = y0 + 5; y < y1 - 6; y += 5) {
    pts.push(`${x + side * 4},${y}`);
    side = -side;
  }
  pts.push(`${x},${y1 - 6}`);
  return (
    <g opacity={faded ? 0.3 : 1}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} />
      <polygon points={`${x - 4},${y1 - 7} ${x + 4},${y1 - 7} ${x},${y1}`} fill={color} />
    </g>
  );
}

function Schematic({ mode, shield, twisted, noise, faults, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const pair = usesPair(mode);
  const diffIn = isDifferential(mode);
  const tw = pair && twisted;
  const xlr = mode === "balanced" || mode === "impedance";
  const sources = NOISES.filter((n) => n.coupling !== "ground");
  const ground = NOISES.find((n) => n.coupling === "ground");
  const groundOn = noise[ground.key] > 0;
  const noiseX = { hum: 200, dimmer: 300, phone: 400 };
  const short = { hum: "hum 50 Hz", dimmer: "dimmer", phone: "GSM" };
  const crossed = faults.swapped && diffIn;

  // Little signal glyphs at the source: the waveform each leg starts with.
  const glyph = (y, polarity) => {
    const pts = [];
    for (let i = 0; i <= 24; i++) pts.push(`${84 + i},${y - polarity * 5 * Math.sin((i / 24) * Math.PI * 2)}`);
    return <polyline points={pts.join(" ")} fill="none" stroke={polarity === 0 ? SHIELD : polarity > 0 ? HOT : COLD} strokeWidth={1.4} />;
  };
  const coldPolarity = mode === "balanced" || mode === "mixed" ? -1 : 0;

  return (
    <div className="mt-2 overflow-x-auto">
      <svg viewBox="0 0 640 240" className="w-full min-w-[520px]" role="img"
        aria-label={t("Esquema de la conexión", "Hookup schematic", "Esquema da ligação", "Schéma du branchement")}>
        {/* noise sources */}
        {sources.map((n) => {
          const on = noise[n.key] > 0;
          const color = on ? n.color : "#475569";
          const blocked = n.coupling === "electric" && shield;
          return (
            <g key={n.key}>
              <text x={noiseX[n.key]} y={16} textAnchor="middle" fill={color} fontSize={10} fontFamily="monospace">{short[n.key]}</text>
              <text x={noiseX[n.key]} y={27} textAnchor="middle" fill="#64748b" fontSize={8} fontFamily="monospace">
                {n.coupling === "magnetic" ? t("magnético", "magnetic", "magnético", "magnétique") : t("eléctrico", "electric", "elétrico", "électrique")}
              </text>
              <Zigzag x={noiseX[n.key]} y0={32} y1={blocked ? 74 : 94} color={color} faded={!on} />
            </g>
          );
        })}

        {/* source */}
        <rect x={14} y={70} width={104} height={100} rx={10} fill="#0f172a" stroke="#334155" />
        <text x={66} y={88} textAnchor="middle" fill="#cbd5e1" fontSize={11}>{t("Fuente", "Source", "Fonte", "Source")}</text>
        <text x={66} y={162} textAnchor="middle" fill="#64748b" fontSize={8} fontFamily="monospace">
          {mode === "unbalanced" ? "TS" : mode === "mixed" ? "TRS" : "XLR"}
        </text>
        {glyph(Y_HOT, 1)}
        {pair && glyph(Y_COLD, coldPolarity)}
        <line x1={66} y1={170} x2={66} y2={196} stroke={SHIELD} strokeWidth={1.5} />
        <Ground x={66} y={196} />

        {/* shield */}
        {shield && (
          <g>
            <rect x={X0 + 18} y={76} width={X1 - X0 - 36} height={88} rx={30} fill="none" stroke={SHIELD} strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={X0 + 70} y={159} fill={SHIELD} fontSize={8} fontFamily="monospace">
              {mode === "unbalanced" ? t("malla = retorno", "shield = return", "malha = retorno", "blindage = retour") : `${t("malla", "shield", "malha", "blindage")}${xlr ? " · pin 1" : ""}`}
            </text>
          </g>
        )}

        {/* conductors */}
        <path d={wire(-1, tw)} fill="none" stroke={HOT} strokeWidth={2.2} />
        {pair ? (
          faults.coldOpen && diffIn ? (
            <g>
              <path d={wire(1, tw, X0, BREAK[0])} fill="none" stroke={COLD} strokeWidth={2.2} />
              <path d={wire(1, tw, BREAK[1], X1)} fill="none" stroke={COLD} strokeWidth={2.2} />
              <text x={(BREAK[0] + BREAK[1]) / 2} y={MID + 34} textAnchor="middle" fill={DANGER} fontSize={14} fontWeight="bold">✕</text>
            </g>
          ) : (
            <path d={wire(1, tw)} fill="none" stroke={COLD} strokeWidth={2.2} />
          )
        ) : (
          <path d={wire(1, false)} fill="none" stroke={SHIELD} strokeWidth={2.2} />
        )}
        <text x={X0 + 4} y={Y_HOT - 6} fill={HOT} fontSize={9} fontFamily="monospace">{xlr ? "2 +" : "tip"}</text>
        <text x={X0 + 4} y={Y_COLD + 14} fill={pair ? COLD : SHIELD} fontSize={9} fontFamily="monospace">
          {xlr ? "3 −" : mode === "mixed" ? "ring" : "sleeve"}
        </text>

        {/* leads into the receiver */}
        {crossed ? (
          <g>
            <line x1={X1} y1={Y_HOT} x2={540} y2={Y_COLD} stroke={HOT} strokeWidth={2.2} />
            <line x1={X1} y1={Y_COLD} x2={540} y2={Y_HOT} stroke={COLD} strokeWidth={2.2} />
            <text x={520} y={MID - 26} textAnchor="middle" fill={DANGER} fontSize={9} fontFamily="monospace">2↔3</text>
          </g>
        ) : (
          <g>
            <line x1={X1} y1={Y_HOT} x2={540} y2={Y_HOT} stroke={HOT} strokeWidth={2.2} />
            {diffIn && <line x1={X1} y1={Y_COLD} x2={540} y2={Y_COLD} stroke={COLD} strokeWidth={2.2} />}
          </g>
        )}
        {!diffIn && (
          <g>
            <polyline points={`${X1},${Y_COLD} 524,${Y_COLD} 524,196`} fill="none" stroke={pair ? COLD : SHIELD} strokeWidth={2.2} />
            <Ground x={524} y={196} />
          </g>
        )}

        {/* receiver */}
        <polygon points="540,80 540,160 608,120" fill="#0f172a" stroke={diffIn ? ACCENT : "#64748b"} strokeWidth={1.6} />
        <text x={547} y={Y_HOT + 4} fill={HOT} fontSize={13} fontFamily="monospace">+</text>
        {diffIn && <text x={547} y={Y_COLD + 4} fill={COLD} fontSize={13} fontFamily="monospace">−</text>}
        <line x1={608} y1={MID} x2={634} y2={MID} stroke={OUT} strokeWidth={2.2} />
        <text x={574} y={72} textAnchor="middle" fill="#cbd5e1" fontSize={10}>
          {diffIn ? t("diferencial", "differential", "diferencial", "différentiel") : t("entrada simple", "single-ended", "entrada simples", "entrée simple")}
        </text>
        {diffIn && (
          <g>
            <line x1={574} y1={146} x2={574} y2={196} stroke={SHIELD} strokeWidth={1.5} />
            <Ground x={574} y={196} />
          </g>
        )}

        {/* ground loop */}
        <g opacity={groundOn ? 1 : 0.3}>
          <path d={`M66,214 L${diffIn ? 574 : 524},214`} fill="none" stroke={groundOn ? ground.color : "#475569"} strokeWidth={1.3} strokeDasharray="4 3" />
          <circle cx={320} cy={214} r={9} fill="#0f172a" stroke={groundOn ? ground.color : "#475569"} strokeWidth={1.3} />
          <text x={320} y={218} textAnchor="middle" fill={groundOn ? ground.color : "#475569"} fontSize={11}>~</text>
          <text x={320} y={236} textAnchor="middle" fill={groundOn ? ground.color : "#475569"} fontSize={9} fontFamily="monospace">
            {t("lazo de masa (tierra de cada enchufe)", "ground loop (each outlet's earth)", "loop de terra (terra de cada tomada)", "boucle de masse (terre de chaque prise)")}
          </text>
        </g>
      </svg>
    </div>
  );
}

/* ===================== comparison ===================== */

function Comparison({ rows, mode, onPick, faulty, snr, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const unbalanced = rows.find((r) => r.key === "unbalanced").snr;
  const bar = (db) => `${Math.max(2, Math.min(100, (Math.min(db, 120) / 120) * 100))}%`;
  return (
    <div className="flex flex-1 flex-col justify-between gap-2.5 pt-3">
      {rows.map((r) => {
        const active = r.key === mode;
        const gain = r.snr - unbalanced;
        return (
          <button key={r.key} onClick={() => onPick(r.key)} className="block w-full text-left group">
            <span className="flex items-baseline justify-between gap-2 text-xs">
              <span className={active ? "text-cyan-200 font-medium" : "text-slate-400 group-hover:text-slate-200"}>
                {localizeText(r.label, language)}
                <span className="ml-1.5 font-mono text-[10px] text-slate-600">{r.connector}</span>
              </span>
              <span className="font-mono tabular-nums" style={{ color: snrColor(r.snr) }}>
                {fmtDb(r.snr)} dB
                {Math.abs(gain) >= 0.5 && Number.isFinite(gain) && (
                  <span className="ml-1.5 text-[10px] text-slate-500">({gain > 0 ? "+" : ""}{gain.toFixed(0)})</span>
                )}
              </span>
            </span>
            <span className={`mt-1 block h-2 rounded-full bg-slate-800 overflow-hidden ${active ? "ring-1 ring-cyan-400/60" : ""}`}>
              <span className="block h-full rounded-full transition-all duration-200"
                style={{ width: bar(r.snr), backgroundColor: snrColor(r.snr) }} />
            </span>
          </button>
        );
      })}
      {faulty && (
        <p className="text-xs font-mono" style={{ color: DANGER }}>
          {t("Con la falla:", "With the fault:", "Com a falha:", "Avec le défaut :")} {fmtDb(snr)} dB
        </p>
      )}
      <p className="text-[11px] text-slate-500 leading-relaxed">
        {t("SNR de un tono a nivel nominal, con los ruidos y el cable de abajo. Entre paréntesis, la mejora sobre el no balanceado.",
          "SNR of a full-level tone, with the noise and cable set below. In brackets, the gain over unbalanced.",
          "SNR de um tom em nível nominal, com os ruídos e o cabo de baixo. Entre parênteses, o ganho sobre o não balanceado.",
          "RSB d'un son au niveau nominal, avec les bruits et le câble ci-dessous. Entre parenthèses, le gain par rapport à l'asymétrique.")}
      </p>
    </div>
  );
}

/* ===================== scope ===================== */

// Drawn in a unit box and stretched to the card; strokes keep their width.
const SCOPE_W = 1000, SCOPE_H = 100;

function polyline(data, yMax) {
  const n = data.length;
  let s = "";
  for (let i = 0; i < n; i++) {
    const y = SCOPE_H / 2 - Math.max(-1.1, Math.min(1.1, data[i] / yMax)) * (SCOPE_H / 2 - 4);
    s += `${((i / (n - 1)) * SCOPE_W).toFixed(1)},${y.toFixed(1)} `;
  }
  return s;
}

function Scope({ label, sub, color, data, ideal, yMax }) {
  const grid = (v) => SCOPE_H / 2 - v * (SCOPE_H / 2 - 4);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="flex items-center gap-1.5 text-slate-300">
          <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: color }} />{label}
        </span>
        <span className="font-mono text-[10px] text-slate-500">{sub}</span>
      </div>
      <div className="relative mt-1 rounded-md border border-slate-800 bg-slate-950/60">
        <svg viewBox={`0 0 ${SCOPE_W} ${SCOPE_H}`} preserveAspectRatio="none" className="block h-16 sm:h-20 w-full">
          {[-1, 0, 1].map((v) => (
            <line key={v} x1={0} x2={SCOPE_W} y1={grid(v)} y2={grid(v)} stroke={v === 0 ? "#334155" : "#1e293b"}
              vectorEffect="non-scaling-stroke" />
          ))}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={f * SCOPE_W} x2={f * SCOPE_W} y1={0} y2={SCOPE_H} stroke="#1e293b" vectorEffect="non-scaling-stroke" />
          ))}
          {ideal && <polyline points={polyline(ideal, yMax)} fill="none" stroke="#e2e8f0" strokeWidth={1.2}
            strokeDasharray="4 3" opacity={0.6} vectorEffect="non-scaling-stroke" />}
          <polyline points={polyline(data, yMax)} fill="none" stroke={color} strokeWidth={1.6}
            strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="absolute left-1.5 top-0.5 font-mono text-[9px] text-slate-600">+{fmtVolts(yMax)}</span>
        <span className="absolute left-1.5 bottom-0.5 font-mono text-[9px] text-slate-600">−{fmtVolts(yMax)}</span>
      </div>
    </div>
  );
}

function Scopes({ mode, model, traces, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const yMax = niceScale(Math.max(peakOf(traces.hot), peakOf(traces.cold), peakOf(traces.out), peakOf(traces.ideal)));
  const noiseOf = (c) => `${t("ruido", "noise", "ruído", "bruit")} ${fmtVolts(noiseRms(c))} rms`;
  const coldLabel = {
    unbalanced: t("Malla / retorno (referencia, 0 V)", "Shield / return (reference, 0 V)", "Malha / retorno (referência, 0 V)", "Blindage / retour (référence, 0 V)"),
    mixed: t("Pin 3 (a masa en el plug TS)", "Pin 3 (grounded by the TS plug)", "Pino 3 (aterrado no plugue TS)", "Broche 3 (à la masse par la fiche TS)"),
    balanced: t("Pata fría · pin 3 (−)", "Cold leg · pin 3 (−)", "Perna fria · pino 3 (−)", "Patte froide · broche 3 (−)"),
    impedance: t("Pata fría · pin 3 (sin señal)", "Cold leg · pin 3 (no signal)", "Perna fria · pino 3 (sem sinal)", "Patte froide · broche 3 (sans signal)"),
  }[mode];
  return (
    <div className="space-y-2 pt-2">
      <Scope label={t("Pata caliente · pin 2 (+)", "Hot leg · pin 2 (+)", "Perna quente · pino 2 (+)", "Patte chaude · broche 2 (+)")}
        sub={noiseOf(model.hot)} color={HOT} data={traces.hot} yMax={yMax} />
      <Scope label={coldLabel} sub={model.cold ? noiseOf(model.cold) : ""}
        color={mode === "unbalanced" ? SHIELD : COLD} data={traces.cold} yMax={yMax} />
      <Scope label={isDifferential(mode)
        ? t("Salida del receptor · 2 − 3", "Receiver output · 2 − 3", "Saída do receptor · 2 − 3", "Sortie du récepteur · 2 − 3")
        : t("Salida del receptor · punta − masa", "Receiver output · tip − ground", "Saída do receptor · ponta − terra", "Sortie du récepteur · pointe − masse")}
        sub={noiseOf(model.out)} color={OUT} data={traces.out} ideal={traces.ideal} yMax={yMax} />
      <div className="flex justify-between font-mono text-[9px] text-slate-600">
        {[0, 5, 10, 15, 20].map((ms) => <span key={ms}>{ms} ms</span>)}
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        {t(`Misma escala en las tres. La punteada es la señal sin ruido. Cada ruido de red se repite a ${MAINS_HZ} Hz; el tono es de ${TONE_HZ} Hz.`,
          `Same scale on all three. The dashed line is the noise-free signal. Mains noise repeats at ${MAINS_HZ} Hz; the tone is ${TONE_HZ} Hz.`,
          `Mesma escala nas três. A tracejada é o sinal sem ruído. Cada ruído da rede se repete a ${MAINS_HZ} Hz; o tom é de ${TONE_HZ} Hz.`,
          `Même échelle sur les trois. La ligne pointillée est le signal sans bruit. Le bruit secteur se répète à ${MAINS_HZ} Hz ; le son est à ${TONE_HZ} Hz.`)}
      </p>
    </div>
  );
}

/* ===================== noise + faults ===================== */

function NoiseControls({ noise, onChange, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const how = {
    hum: t("Campo magnético de un transformador o un motor. Induce tensión en el lazo entre los conductores: sólo lo frena el trenzado.",
      "Magnetic field from a transformer or motor. It induces voltage in the loop between the conductors: only twisting stops it.",
      "Campo magnético de um transformador ou motor. Induz tensão no laço entre os condutores: só o trançado o detém.",
      "Champ magnétique d'un transformateur ou d'un moteur. Il induit une tension dans la boucle entre les conducteurs : seule la torsade l'arrête."),
    dimmer: t("Flancos bruscos de un dimmer o una fuente conmutada que se acoplan por capacidad. La malla los drena a masa.",
      "Sharp edges from a dimmer or a switch-mode supply, coupled capacitively. The shield drains them to ground.",
      "Bordas bruscas de um dimmer ou de uma fonte chaveada que se acoplam por capacitância. A malha as drena para a terra.",
      "Fronts raides d'un variateur ou d'une alim. à découpage, couplés par capacité. Le blindage les draine à la masse."),
    phone: t("El \"tiki-tiki-tiki\" de un celular GSM: ráfagas a 217 Hz que cualquier semiconductor demodula.",
      "The \"dit-dit-dit\" of a GSM phone: 217 Hz bursts that any semiconductor demodulates.",
      "O \"tique-tique-tique\" de um celular GSM: rajadas a 217 Hz que qualquer semicondutor demodula.",
      "Le « tit-tit-tit » d'un téléphone GSM : des salves à 217 Hz que n'importe quel semi-conducteur démodule."),
    ground: t("Dos equipos enchufados en tomas distintas no tienen exactamente la misma tierra; la diferencia hace circular corriente por la malla.",
      "Two devices plugged into different outlets don't share exactly the same earth; the difference drives current through the shield.",
      "Dois equipamentos ligados em tomadas diferentes não têm exatamente o mesmo terra; a diferença faz circular corrente pela malha.",
      "Deux appareils branchés sur des prises différentes n'ont pas exactement la même terre ; la différence fait circuler du courant dans le blindage."),
  };
  return (
    <div className="space-y-3 pt-2">
      {NOISES.map((n) => {
        const Icon = NOISE_ICONS[n.key];
        const v = noise[n.key];
        return (
          <div key={n.key} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm text-slate-200">
                <Icon size={15} style={{ color: n.color }} />
                {localizeText(n.label, language)}
              </span>
              <span className="font-mono text-xs tabular-nums" style={{ color: v > 0 ? n.color : "#64748b" }}>
                {Math.round(v * 100)} %
              </span>
            </div>
            <input type="range" min={0} max={1} step={0.01} value={v}
              onChange={(e) => onChange({ ...noise, [n.key]: Number(e.target.value) })}
              className="w-full cursor-pointer" style={{ accentColor: n.color }}
              aria-label={localizeText(n.label, language)} />
            <p className="text-[11px] text-slate-500 leading-relaxed">{how[n.key]}</p>
          </div>
        );
      })}
    </div>
  );
}

function SourceTable({ model, noise, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const coupling = {
    magnetic: t("magnético", "magnetic", "magnético", "magnétique"),
    electric: t("eléctrico", "electric", "elétrico", "électrique"),
    ground: t("masa", "ground", "terra", "masse"),
  };
  // Improvement in noise-to-signal ratio from the cable to the output.
  const gain = (k) => {
    const before = Math.abs(model.hot[k] / model.hot.signal);
    const after = Math.abs(model.out[k] / model.out.signal);
    if (!before) return null;
    return after ? 20 * Math.log10(before / after) : Infinity;
  };
  return (
    <div className="pt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-500">
            <th className="py-1.5 text-left font-medium">{t("Fuente", "Source", "Fonte", "Source")}</th>
            <th className="py-1.5 text-right font-medium">{t("En el pin 2", "On pin 2", "No pino 2", "Sur la broche 2")}</th>
            <th className="py-1.5 text-right font-medium">{t("A la salida", "At the output", "Na saída", "En sortie")}</th>
            <th className="py-1.5 text-right font-medium">{t("Mejora", "Gain", "Ganho", "Gain")}</th>
          </tr>
        </thead>
        <tbody>
          {NOISES.map((n) => {
            const on = noise[n.key] > 0;
            const g = gain(n.key);
            return (
              <tr key={n.key} className="border-t border-slate-800">
                <td className="py-2">
                  <span className="block" style={{ color: on ? n.color : "#64748b" }}>{localizeText(n.label, language)}</span>
                  <span className="text-[10px] text-slate-600">{coupling[n.coupling]}</span>
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-slate-400">
                  {on ? fmtVolts(Math.abs(model.hot[n.key]) * waveRms(n.key)) : "—"}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-slate-300">
                  {on ? fmtVolts(Math.abs(model.out[n.key]) * waveRms(n.key)) : "—"}
                </td>
                <td className="py-2 text-right font-mono tabular-nums"
                  style={{ color: g == null ? "#64748b" : g >= 30 ? "#34d399" : g >= 10 ? "#f59e0b" : DANGER }}>
                  {g == null ? "—" : `${fmtDb(g)} dB`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
        {t("Ruido en mV rms. La mejora compara ruido/señal en el cable contra ruido/señal a la salida, así que incluye los 6 dB de la señal duplicada.",
          "Noise in mV rms. The gain compares noise/signal on the cable against noise/signal at the output, so it includes the 6 dB of the doubled signal.",
          "Ruído em mV rms. O ganho compara ruído/sinal no cabo com ruído/sinal na saída, então inclui os 6 dB do sinal dobrado.",
          "Bruit en mV rms. Le gain compare bruit/signal sur le câble et bruit/signal en sortie : il inclut les 6 dB du signal doublé.")}
      </p>
    </div>
  );
}

function FaultControls({ faults, onChange, enabled, language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  return (
    <div className="pt-2">
      <div className="flex flex-wrap gap-2">
        <Toggle on={enabled && faults.coldOpen} disabled={!enabled} onClick={() => onChange({ ...faults, coldOpen: !faults.coldOpen })}
          label={t("Pin 3 cortado", "Pin 3 open", "Pino 3 cortado", "Broche 3 coupée")} />
        <Toggle on={enabled && faults.swapped} disabled={!enabled} onClick={() => onChange({ ...faults, swapped: !faults.swapped })}
          label={t("Pines 2 y 3 cruzados", "Pins 2 and 3 swapped", "Pinos 2 e 3 trocados", "Broches 2 et 3 inversées")} />
      </div>
      <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
        {enabled
          ? t("Un cable con el pin 3 cortado sigue sonando, 6 dB más bajo y con todo el ruido: es la falla que más tarda en descubrirse. Con 2 y 3 cruzados suena igual sola, pero sumada a otro micrófono que capta lo mismo, se cancelan: el sonido se vuelve finito y sin graves.",
            "A cable with pin 3 open still works, 6 dB quieter and with all the noise: it's the fault that takes longest to find. With 2 and 3 swapped it sounds fine on its own, but mixed with another mic picking up the same source they cancel: the sound turns thin and loses its lows.",
            "Um cabo com o pino 3 cortado continua soando, 6 dB mais baixo e com todo o ruído: é a falha que mais demora a ser descoberta. Com 2 e 3 trocados soa igual sozinho, mas somado a outro microfone que capta o mesmo, eles se cancelam: o som fica fino e sem graves.",
            "Un câble avec la broche 3 coupée marche encore, 6 dB plus bas et avec tout le bruit : c'est la panne la plus longue à trouver. Avec 2 et 3 inversées, il sonne bien seul, mais mélangé à un autre micro qui capte la même source, ils s'annulent : le son devient maigre et perd ses graves.")
          : t("Elegí una conexión balanceada para simular fallas en sus patas.",
            "Pick a balanced hookup to simulate faults on its legs.",
            "Escolha uma ligação balanceada para simular falhas nas suas pernas.",
            "Choisis un branchement symétrique pour simuler des défauts sur ses pattes.")}
      </p>
    </div>
  );
}

/* ===================== guide ===================== */

function Guide({ language }) {
  const t = (es, en, pt, fr) => pick(language, es, en, pt, fr);
  const items = [
    {
      title: t("Dos patas, una resta", "Two legs, one subtraction", "Duas pernas, uma subtração", "Deux pattes, une soustraction"),
      body: t("El receptor no mira cada pata contra masa: mira la DIFERENCIA entre las dos. Si el ruido llega igual a ambas (modo común), al restar desaparece. La señal, que va en contrafase, se suma.",
        "The receiver doesn't look at each leg against ground: it looks at the DIFFERENCE between them. If noise reaches both alike (common mode), subtracting removes it. The signal, in opposite polarity, adds up.",
        "O receptor não olha cada perna contra a terra: olha a DIFERENÇA entre as duas. Se o ruído chega igual a ambas (modo comum), ao subtrair desaparece. O sinal, em contrafase, se soma.",
        "Le récepteur ne regarde pas chaque patte par rapport à la masse : il regarde la DIFFÉRENCE entre les deux. Si le bruit arrive pareil sur les deux (mode commun), la soustraction l'élimine. Le signal, en opposition de phase, s'additionne."),
    },
    {
      title: t("El truco es la impedancia", "The trick is the impedance", "O truque é a impedância", "Le secret, c'est l'impédance"),
      body: t("Para que el ruido llegue igual, las dos patas tienen que tener la misma impedancia contra masa. La señal invertida en el pin 3 es un bonus (+6 dB y más margen), no el motivo: por eso existen las salidas balanceadas por impedancia.",
        "For noise to arrive alike, both legs must present the same impedance to ground. The inverted signal on pin 3 is a bonus (+6 dB and more headroom), not the reason: that's why impedance-balanced outputs exist.",
        "Para o ruído chegar igual, as duas pernas precisam ter a mesma impedância contra a terra. O sinal invertido no pino 3 é um bônus (+6 dB e mais margem), não o motivo: por isso existem as saídas balanceadas por impedância.",
        "Pour que le bruit arrive pareil, les deux pattes doivent présenter la même impédance par rapport à la masse. Le signal inversé sur la broche 3 est un bonus (+6 dB et plus de marge), pas la raison : d'où les sorties symétriques par impédance."),
    },
    {
      title: t("Trenzado contra lo magnético", "Twisting against magnetism", "Trançado contra o magnético", "La torsade contre le magnétique"),
      body: t("Un campo magnético induce tensión en el área que encierran los dos cables. Al trenzarlos, cada vuelta invierte el lazo y las tensiones se cancelan de a pares. La malla de cobre no sirve contra 50 Hz magnéticos.",
        "A magnetic field induces voltage in the area enclosed by the two wires. Twisted, each turn flips the loop and the voltages cancel in pairs. A copper shield does nothing against 50 Hz magnetic fields.",
        "Um campo magnético induz tensão na área que os dois fios encerram. Ao trançá-los, cada volta inverte o laço e as tensões se cancelam aos pares. A malha de cobre não serve contra 50 Hz magnéticos.",
        "Un champ magnétique induit une tension dans la surface enfermée par les deux fils. Torsadés, chaque tour inverse la boucle et les tensions s'annulent par paires. Un blindage en cuivre ne fait rien contre un champ magnétique à 50 Hz."),
    },
    {
      title: t("Malla contra lo eléctrico", "Shield against electric fields", "Malha contra o elétrico", "Le blindage contre l'électrique"),
      body: t("Dimmers, fuentes conmutadas y radios acoplan ruido por capacidad. Una malla conectada a masa lo intercepta antes de que llegue a los conductores.",
        "Dimmers, switch-mode supplies and radios couple noise capacitively. A grounded shield intercepts it before it reaches the conductors.",
        "Dimmers, fontes chaveadas e rádios acoplam ruído por capacitância. Uma malha ligada à terra o intercepta antes que chegue aos condutores.",
        "Variateurs, alims à découpage et radios couplent du bruit par capacité. Un blindage relié à la masse l'intercepte avant qu'il n'atteigne les conducteurs."),
    },
    {
      title: t("Lazos de masa", "Ground loops", "Loops de terra", "Boucles de masse"),
      body: t("En un cable no balanceado la malla es a la vez masa y retorno de la señal: la corriente entre las tierras de dos enchufes cae sobre ella y se suma al audio. En uno balanceado esa caída es común a las dos patas y se rechaza. Nunca se levanta la tierra de seguridad: se usa una línea balanceada o una DI/transformador de aislación.",
        "On an unbalanced cable the shield is both ground and signal return: current between two outlets' earths drops across it and adds to the audio. On a balanced one that drop is common to both legs and gets rejected. Never lift the safety earth: use a balanced line or a DI/isolation transformer.",
        "Num cabo não balanceado a malha é ao mesmo tempo terra e retorno do sinal: a corrente entre os terras de duas tomadas cai sobre ela e se soma ao áudio. Num balanceado essa queda é comum às duas pernas e é rejeitada. Nunca se levanta o terra de segurança: usa-se uma linha balanceada ou uma DI/transformador de isolação.",
        "Sur un câble asymétrique, le blindage est à la fois masse et retour du signal : le courant entre les terres de deux prises y chute et s'ajoute à l'audio. Sur un câble symétrique, cette chute est commune aux deux pattes et rejetée. Ne jamais lever la terre de sécurité : utiliser une ligne symétrique ou une DI/un transformateur d'isolement."),
    },
    {
      title: t("Por qué los micrófonos siempre son balanceados", "Why microphones are always balanced", "Por que os microfones são sempre balanceados", "Pourquoi les micros sont toujours symétriques"),
      body: t("Un micrófono entrega milivolts y viaja metros por el escenario: el mismo ruido pesa 50 dB más que en una señal de línea. Y de yapa, la fantasma de 48 V viaja igual por los pines 2 y 3: para el receptor es modo común y la ignora.",
        "A microphone puts out millivolts and travels metres across the stage: the same noise weighs 50 dB more than on a line signal. And as a bonus, 48 V phantom power rides equally on pins 2 and 3: to the receiver it's common mode, so it ignores it.",
        "Um microfone entrega milivolts e viaja metros pelo palco: o mesmo ruído pesa 50 dB a mais do que num sinal de linha. E de quebra, a phantom de 48 V viaja igual pelos pinos 2 e 3: para o receptor é modo comum e ele a ignora.",
        "Un micro sort quelques millivolts et parcourt des mètres de scène : le même bruit pèse 50 dB de plus que sur un signal ligne. En prime, l'alimentation fantôme 48 V circule pareil sur les broches 2 et 3 : pour le récepteur c'est du mode commun, il l'ignore."),
    },
  ];
  return (
    <Card title={t("Por qué funciona", "Why it works", "Por que funciona", "Pourquoi ça marche")} icon={<BookOpen size={15} />}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3">
        {items.map((it) => (
          <div key={it.title} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <h2 className="text-sm font-medium text-slate-200">{it.title}</h2>
            <p className="mt-1 text-xs text-slate-400 leading-relaxed">{it.body}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
