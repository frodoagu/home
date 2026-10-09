// Layers and their factory variants, in display order. Variant ids are the
// keys of DEFAULTS in audio/patterns.js, where what each one plays lives as
// data; names and descriptions live in the dictionaries (i18n/).

export const LAYERS = [
  {
    id: "kick",
    exclusive: true,
    variants: [
      "kick.punchy", "kick.long", "kick.tok", "kick.fullon", "kick.techno",
      "kick.rumble", "kick.prog", "kick.psytech", "kick.dark",
    ],
  },
  {
    id: "bass",
    exclusive: true,
    variants: [
      "bass.offbeat", "bass.rolling", "bass.rollingOct", "bass.gallop", "bass.fm",
      "bass.prog", "bass.techno", "bass.hitech", "bass.phrygian",
    ],
  },
  {
    id: "perc",
    variants: [
      "perc.hat", "perc.chat", "perc.shaker", "perc.clap", "perc.snare",
      "perc.ride", "perc.toms", "perc.hat16", "perc.rim",
    ],
  },
  {
    id: "lead",
    variants: [
      "lead.acid", "lead.arp", "lead.arp3", "lead.melodic", "lead.stabs",
      "lead.zap", "lead.bell", "lead.acidPhryg", "lead.techno",
    ],
  },
  {
    id: "pad",
    variants: [
      "pad.chord", "pad.prog", "pad.drone", "pad.air", "pad.sus",
      "pad.dark", "pad.epic", "pad.supersaw", "pad.fifths",
    ],
  },
  {
    id: "fx",
    oneShot: true,
    variants: [
      "fx.riser", "fx.riserImpact", "fx.down", "fx.sweep", "fx.impact",
      "fx.zap", "fx.crash", "fx.siren", "fx.reverse",
    ],
  },
];

export const LAYER_IDS = LAYERS.map((l) => l.id);

export const layerById = (id) => LAYERS.find((l) => l.id === id);

export const layerOfVariant = (id) => id.split(".")[0];
