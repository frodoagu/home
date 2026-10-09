// Layers and variants as the UI shows them. Variant ids are the keys of
// DEFAULTS in audio/patterns.js, where what each one plays lives as data.

export const LAYERS = [
  {
    id: "kick",
    name: "Kick",
    exclusive: true,
    hint: "Un golpe por negra. Compará el click del ataque contra el largo de la cola.",
    variants: [
      { id: "kick.punchy", label: "Punchy corto", detail: "170→50 Hz en 70 ms, 200 ms" },
      { id: "kick.long", label: "Cuerpo largo", detail: "120→42 Hz en 160 ms, 340 ms" },
      { id: "kick.tok", label: "Tok hi-tech", detail: "230→58 Hz en 35 ms, 120 ms" },
      { id: "kick.fullon", label: "Full-on gordo", detail: "150→46 Hz en 100 ms, 260 ms" },
    ],
  },
  {
    id: "bass",
    name: "Bajo",
    exclusive: true,
    hint: "Entre los kicks, en La1 (55 Hz). Contá cuántas notas caen por beat; probá otro sinte en el editor.",
    variants: [
      { id: "bass.offbeat", label: "Offbeat", detail: "1 nota, en el contratiempo" },
      { id: "bass.rolling", label: "Rolling", detail: "3 notas entre kicks" },
      { id: "bass.rollingOct", label: "Rolling con octava", detail: "la del medio, una octava arriba" },
      { id: "bass.gallop", label: "Galope", detail: "2 notas: K-BB" },
    ],
  },
  {
    id: "perc",
    name: "Percusión",
    hint: "Se apilan: con «Combinar capas» sumá varias. Fijate en qué parte del beat cae cada una.",
    variants: [
      { id: "perc.hat", label: "Hi-hat abierto", detail: "contratiempo, HP 7 kHz" },
      { id: "perc.chat", label: "Hi-hat cerrado", detail: "semicorcheas impares, 35 ms" },
      { id: "perc.shaker", label: "Shaker", detail: "cada semicorchea, acento alterno" },
      { id: "perc.clap", label: "Clap", detail: "beats 2 y 4, BP 1,8 kHz" },
      { id: "perc.snare", label: "Snare", detail: "2 y 4 + redoble al final" },
      { id: "perc.ride", label: "Ride", detail: "metal 808, acento en el contratiempo" },
      { id: "perc.toms", label: "Toms tribales", detail: "goa: afinados, con fill" },
    ],
  },
  {
    id: "lead",
    name: "Lead",
    hint: "La capa melódica; se apilan. Abrí el editor (▾) para escribir notas, cambiar el sinte o improvisar.",
    variants: [
      { id: "lead.acid", label: "Ácido", detail: "303: filtro resonante, La menor" },
      { id: "lead.arp", label: "Arpegio", detail: "square, La-Do-Mi-La" },
      { id: "lead.arp3", label: "Arpegio 3/16", detail: "pluck, ciclo de 3 contra 4" },
      { id: "lead.melodic", label: "Melódico", detail: "saw sostenida, una nota cada 2 beats" },
      { id: "lead.stabs", label: "Stabs", detail: "supersaw, acorde sincopado" },
    ],
  },
  {
    id: "pad",
    name: "Pad",
    hint: "Colchón armónico sin transitorios: se nota más cuando lo sacás. Se apilan.",
    variants: [
      { id: "pad.chord", label: "La menor", detail: "3 notas × 2 saws ±7 cents" },
      { id: "pad.prog", label: "Am → Si♭", detail: "el giro frigio del psy" },
      { id: "pad.drone", label: "Drone", detail: "La + Mi graves, filtro que respira" },
      { id: "pad.air", label: "Viento", detail: "ruido afinado en La" },
    ],
  },
  {
    id: "fx",
    name: "FX",
    hint: "Transiciones de un disparo, fuera del loop. Con el loop andando entran en el próximo beat.",
    oneShot: true,
    variants: [
      { id: "fx.riser", label: "Riser", detail: "2 compases, 300→9000 Hz" },
      { id: "fx.riserImpact", label: "Riser + impacto", detail: "el impacto cae al final" },
      { id: "fx.down", label: "Downlifter", detail: "1 compás, cae" },
      { id: "fx.sweep", label: "Sweep de ruido", detail: "1 compás, sube y baja" },
      { id: "fx.impact", label: "Impacto", detail: "seno 90→28 Hz + ruido" },
      { id: "fx.zap", label: "Láser", detail: "saw 4 kHz→60 Hz" },
      { id: "fx.crash", label: "Crash", detail: "ruido HP, 2 s" },
      { id: "fx.siren", label: "Sirena goa", detail: "saw que sube 2 octavas con vibrato" },
    ],
  },
];
