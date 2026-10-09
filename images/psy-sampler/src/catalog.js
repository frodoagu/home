// Layers and variants as the UI shows them. Variant ids are the keys of the
// loop patterns (audio/patterns.js) or of the one-shot FX (audio/voices.js).

export const LAYERS = [
  {
    id: "kick",
    name: "Kick",
    hint: "Un golpe por negra. Compará el click del ataque contra el largo de la cola.",
    variants: [
      { id: "kick.punchy", label: "Punchy corto", detail: "170→50 Hz en 70 ms, 200 ms" },
      { id: "kick.long", label: "Cuerpo largo", detail: "120→42 Hz en 160 ms, 340 ms" },
    ],
  },
  {
    id: "bass",
    name: "Bajo",
    hint: "Saw filtrada en La1 (55 Hz), entre los kicks. Contá cuántas notas caen por beat.",
    variants: [
      { id: "bass.offbeat", label: "Offbeat", detail: "1 nota, en el contratiempo" },
      { id: "bass.rolling", label: "Rolling", detail: "3 notas entre kicks" },
      { id: "bass.rollingOct", label: "Rolling con octava", detail: "la del medio, una octava arriba" },
    ],
  },
  {
    id: "perc",
    name: "Percusión",
    hint: "Ruido filtrado: fijate en qué parte del beat cae y qué tan brillante suena.",
    variants: [
      { id: "perc.hat", label: "Hi-hat abierto", detail: "contratiempo, HP 7 kHz" },
      { id: "perc.shaker", label: "Shaker", detail: "cada semicorchea, acento alterno" },
      { id: "perc.clap", label: "Clap", detail: "beats 2 y 4, BP 1,8 kHz" },
    ],
  },
  {
    id: "lead",
    name: "Lead",
    hint: "La capa melódica. El ácido habla por el filtro resonante; el arpegio despliega el acorde.",
    variants: [
      { id: "lead.acid", label: "Ácido", detail: "saw + filtro resonante, La menor" },
      { id: "lead.arp", label: "Arpegio", detail: "square, La-Do-Mi-La" },
      { id: "lead.melodic", label: "Melódico", detail: "saw sostenida, una nota cada 2 beats" },
    ],
  },
  {
    id: "pad",
    name: "Pad",
    hint: "Colchón armónico sin transitorios: se nota más cuando lo sacás.",
    variants: [{ id: "pad.chord", label: "La menor", detail: "3 notas × 2 saws ±7 cents" }],
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
    ],
  },
];
