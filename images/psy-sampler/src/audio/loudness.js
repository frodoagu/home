// How loud each sound starts, by ear. Every factory sound was rendered
// offline at 145 BPM and measured the way a listener hears it, not by its
// peak or RMS: each third-octave band's level is read off the ISO 226:2003
// equal-loudness contour at that band's own level (the ear is most
// sensitive around 3 kHz, and the lows grow faster as they get louder), the
// bands are summed into sones by Stevens' Mark VI (ISO 532A), and a loop
// counts by its N5, the loudness it passes 5 % of the time (ISO 532-1), so a
// kick's pulses weigh like a pad's drone. docs/psy-sampler.md#loudness has
// the method, its sources and the numbers.
//
// - SYNTH_DB matches the instruments of a group to each other, averaged
//   over every part of that group, so a synth swap (the seed's dress, the
//   ✨ AI's, the editor's select) keeps the volume.
// - DB then sets each factory sound against the kicks, which are the
//   reference and stay at 0: the bass 1 phon under them, classics 2, leads
//   3, pads 6. Percussion and glitches are only pulled down where they
//   pass 4 and 5 under, and FX where a one-shot sticks out. No boost takes
//   a sound past -1 dBFS.
//
// Both scale the lane, under the layer's level and over the sound's own
// volume (`level`, which the autopilot rides). A user's sample replaces the
// voice, so it skips both.
import { baseOf, defOf } from "./patterns.js";

export const SYNTH_DB = {
  bass: -5.4,
  sub: 3.4,
  fmBass: -2.7,
  reese: -6.2,
  organBass: 8,
  wavetable: 2.9,
  acid: -1.9,
  supersaw: -1.9,
  analog: -2.1,
  funky: 1.2,
  organ: 4.3,
  piano: 3.9,
  pluck: -1,
  arp: 2.7,
  lead: -1,
  fmBell: 0.9,
  zap: -2.6,
  bitLead: 0.1,
  chirp: -2,
  glide: -0.4,
  vowel: 1.4,
  rubber: 0.7,
  squelch: -4,
  insect: -2.8,
  morph: 4.6,
  pad: 0.7,
  drone: -0.9,
  air: -1.3,
  grains: 1.4,
};

export const DB = {
  "bass.offbeat": 7.1,
  "bass.rolling": 6.8,
  "bass.rollingOct": 4.7,
  "bass.gallop": 7,
  "bass.fm": 5.7,
  "bass.prog": 3.2,
  "bass.techno": 7.4,
  "bass.hitech": 2.1,
  "bass.phrygian": 6.9,
  "bass.house": 1,
  "bass.deep": 3.2,
  "bass.techHouse": 5,
  "bass.wavetable": 5.2,

  "perc.clap": -2.7,
  "perc.snare": -2.7,
  "perc.keys": -3.4,
  "perc.bongos": -0.3,

  "lead.acid": -2.2,
  "lead.arp": -2.8,
  "lead.arp3": -3.6,
  "lead.melodic": -2.9,
  "lead.stabs": -7.3,
  "lead.zap": -4,
  "lead.bell": -3.6,
  "lead.acidPhryg": -2.5,
  "lead.techno": -10.6,
  "lead.bits": -2.3,
  "lead.chirp": -6,
  "lead.soaring": -3,
  "lead.grid": -4.8,
  "lead.vowel": -3.5,
  "lead.rubber": -2,
  "lead.squelch": -5.6,
  "lead.insect": -4.7,
  "lead.morph": -2.4,
  "lead.chaos": -2.6,
  "lead.piano": -9.9,
  "lead.organ": -11,

  "pad.chord": -6.8,
  "pad.prog": -6.3,
  "pad.drone": -3.6,
  "pad.air": -4.6,
  "pad.sus": -6.2,
  "pad.dark": -5.1,
  "pad.epic": -6.6,
  "pad.supersaw": -13.4,
  "pad.fifths": -4.9,
  "pad.grains": -7.5,
  "pad.glass": -7.6,
  "pad.deep": -7.4,

  "glitch.zips": -3.9,
  "glitch.metal": -3.2,
  "glitch.ring": -2.5,
  "glitch.rise": -1.2,
  "glitch.comb": -0.5,

  "classic.sandstorm": -4.2,
  "classic.axelF": -4.5,
  "classic.popcorn": -5,
  "classic.tetris": -3.9,
  "classic.mountainKing": -6.7,
  "classic.furElise": -6,
  "classic.toccata": -12.7,
  "classic.funkytown": -3.6,
  "classic.misirlou": -4.4,

  "fx.tapeStop": -7.2,
};

const linear = (db = 0) => 10 ** (db / 20);

/** The gain `id` plays at, as `data` (its live data) has it: 1 for a sample. */
export function trimOf(id, data) {
  if (data.sample) return 1;
  const synth = defOf(id).kind === "notes" ? linear(SYNTH_DB[data.synth]) : 1;
  return linear(DB[baseOf(id)]) * synth;
}
