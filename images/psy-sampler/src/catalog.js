// Layers and their factory variants, in display order. Variant ids are the
// keys of DEFAULTS in audio/patterns.js, where what each one plays lives as
// data; names and descriptions live in the dictionaries (i18n/).

export const LAYERS = [
  { id: "kick", exclusive: true, variants: ["kick.punchy", "kick.long", "kick.tok", "kick.fullon"] },
  { id: "bass", exclusive: true, variants: ["bass.offbeat", "bass.rolling", "bass.rollingOct", "bass.gallop"] },
  {
    id: "perc",
    variants: ["perc.hat", "perc.chat", "perc.shaker", "perc.clap", "perc.snare", "perc.ride", "perc.toms"],
  },
  { id: "lead", variants: ["lead.acid", "lead.arp", "lead.arp3", "lead.melodic", "lead.stabs"] },
  { id: "pad", variants: ["pad.chord", "pad.prog", "pad.drone", "pad.air"] },
  {
    id: "fx",
    oneShot: true,
    variants: ["fx.riser", "fx.riserImpact", "fx.down", "fx.sweep", "fx.impact", "fx.zap", "fx.crash", "fx.siren"],
  },
];

export const LAYER_IDS = LAYERS.map((l) => l.id);

export const layerById = (id) => LAYERS.find((l) => l.id === id);

export const layerOfVariant = (id) => id.split(".")[0];
