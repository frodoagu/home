// The autopilot's ✨ AI option: a language model (ai.js: Chrome's built-in
// one, or an LM Studio endpoint) plans the sections ahead of the one playing,
// one ask each, AHEAD of them: which section, how long, which sounds each
// layer plays, how they are dressed (dress.js restyle) and the melodic parts,
// as degrees the pilot develops (editing.js writePart). Pure: this builds the
// prompt and the JSON
// Schema the answer must follow, and normalizePlan() is the gate every plan
// goes through (the model's, or one from a share link) before the pilot takes
// it (autopilot.js withPlan). FX and the swaps inside a section still come
// from the seed. Before those, a run asks for the form of the next track
// (formPrompt): one of FORMS, picked by the length of the set, and how long
// each of its sections lasts, which the pilot walks (autopilot.js withForm)
// and each section's plan then fills in; the next form is asked as one runs out.
// 🌅 asks for the closing in its place (closingPrompt): the last sections
// before the outro, in the time the set has left, and then each plan,
// the outro's last (outroSchema, normalizeOutro).
//
// Every ask's instructions open on a brief of the track (briefOf): the
// style's genre, tempo and key, the BPM and the listener's wish, read off the
// settings, so the model arranges the genre picked and not another. The
// rules of the listener's LEVEL follow it (systemOf). With a wish, one ask
// comes before any other (tunePrompt): the wish in English and the style's
// genre rewritten to it, which the brief then carries in their place.
//
// How much it asks is the listener's LEVEL: low is the short prompt a small
// model on a laptop (Gemini Nano) answers in time, the sections and their
// sounds only: no form, no dress, no parts. mid adds those; high also has
// the model build each sound's filter, sweep, distortion, tremolo, autopan
// and echo (dress.js TWEAKS); max also tells it each sound's role (ROLE)
// and the listener's own words for it, where they wrote some
// (`descriptions`). `describe` off lists the sounds by id alone.
import { LAYERS, layerById, layerOfVariant } from "./catalog.js";
import { CLOSE_MAX, OUTRO, SECTIONS, SECTION_IDS, STYLES, THEME_PATH, countRange, leftOut, poolOf } from "./autopilot.js";
import { SYNTHS } from "./audio/params.js";
import { baseOf, defOf, isCopy } from "./audio/patterns.js";
import { CHOICES, MACROS, MACRO_MAX, TWEAKS, UNIT_TWEAKS, fits, moves, synthsFor } from "./dress.js";
import { DEGREES, PART_LENGTHS, REST } from "./editing.js";
import { laneKey } from "./selection.js";
import en from "./i18n/en.js";

export const LEVELS = ["low", "mid", "high", "max"];
export const LEVEL_DEFAULT = "mid";
const levelOf = (level) => (LEVELS.includes(level) ? level : LEVEL_DEFAULT);
// What a level asks the model to answer besides the sounds.
export const asksForm = (level) => levelOf(level) !== "low";
const dresses = (level) => levelOf(level) !== "low";
const tweaks = (level) => ["high", "max"].includes(levelOf(level));
const tells = (level) => levelOf(level) === "max";

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot && !l.manual);
// An intro opens a track; a plan always picks what follows one.
export const PLAN_SECTIONS = SECTION_IDS.filter((id) => id !== "intro");
// Plans a share link carries at most: one per section, about 6 h of track.
export const PLAN_MAX = 256;
// Sections the ✨ AI keeps planned past the one playing.
export const AHEAD = 3;
// The forms a track takes, from the groove it opens on to the breakdown it
// ends on; the next track opens on a groove again. Which one is the ✨ AI's
// call (formPrompt), by the length of the set: FORM_OF_SET, as a rule.
export const FORMS = {
  short: ["groove", "build", "peak", "breakdown"],
  mid: ["groove", "build", "peak", "build", "peak", "breakdown"],
  long: ["groove", "build", "peak", "build", "peak", "build", "breakdown"],
};
export const FORM_IDS = Object.keys(FORMS);
const FORM_MAX = Math.max(...Object.values(FORMS).map((f) => f.length));
export const FORM_OF_SET = { 0: "mid", 60: "short", 120: "mid", 180: "long" };
// The lengths a listener may give a section coming, in bars: whole 8-bar
// phrases, so they still line up with it.
export const BARS_BY_HAND = [8, 16, 24, 32, 40, 48, 56, 64];

// How long the listener means the set to last, in minutes (0: open-ended).
// Where the track is in it shapes each plan, the way a DJ paces a night.
export const SET_LENGTHS = [0, 60, 120, 180];
const SET_STAGES = [
  [0.25, "the warm-up: patient energy, long grooves and breakdowns, few and gentle peaks"],
  [0.6, "the rise of the night: the energy climbs, peaks come more often and hit harder"],
  [0.9, "the heart of the set: the strongest peaks, the energy at its highest, short breaks"],
  [Infinity, "the closing: wind the energy down, longer breakdowns, and a last peak to say goodbye"],
];

/** The line placing a plan in the set (`minutes` long, `elapsed` seconds played), or null. */
export function setLine({ minutes = 0, elapsed = 0 } = {}) {
  if (!SET_LENGTHS.includes(minutes) || !minutes) return null;
  const played = Math.min(minutes, Math.floor(Math.max(0, elapsed) / 60));
  const share = played / minutes;
  const [, stage] = SET_STAGES.find(([upTo]) => share < upTo);
  return `The set lasts about ${minutes / 60} hour${minutes > 60 ? "s" : ""}; ${played} minutes have played (${Math.round(share * 100)} %), so this is ${stage}.`;
}
const HISTORY = 8; // sections the prompt recalls
const RECALLED = 3; // of those, the ones it lists the sounds of
const WHY_MAX = 200;
const WHY_LOW = 80; // the low level's: every token a small model writes is time

// What each sound sounds like, in the words a listener asks with: the
// i18n names say how a sound is made, not whether it is dark or euphoric.
export const CHARACTER = {
  "kick.punchy": "tight, driving",
  "kick.long": "deep, warm, heavy",
  "kick.tok": "short, clicky, hi-tech",
  "kick.fullon": "fat, driving, energetic",
  "kick.techno": "hard, booming",
  "kick.rumble": "dark, rumbling, heavy",
  "kick.prog": "soft, smooth, deep",
  "kick.psytech": "dry, tight, minimal",
  "kick.dark": "dark, sharp, minimal",
  "kick.house": "round, warm, groovy",
  "kick.techHouse": "tight, punchy, groovy",
  "bass.offbeat": "sparse, minimal, bouncy",
  "bass.rolling": "driving, busy, full-on",
  "bass.rollingOct": "bright, busy, energetic",
  "bass.gallop": "bouncy, driving",
  "bass.fm": "gritty, driving",
  "bass.prog": "deep, smooth, sparse",
  "bass.techno": "dark, gritty, hypnotic",
  "bass.hitech": "fast, busy, twisted",
  "bass.phrygian": "dark, driving, exotic",
  "bass.house": "funky, bouncy, warm",
  "bass.techHouse": "groovy, rolling, punchy",
  "bass.deep": "deep, round, spacious",
  "bass.wavetable": "rolling, biting, driving",
  "perc.hat": "airy, sparse",
  "perc.chat": "tight, minimal",
  "perc.shaker": "busy, groovy",
  "perc.clap": "punchy, sparse",
  "perc.snare": "energetic, building",
  "perc.ride": "metallic, driving",
  "perc.toms": "tribal, busy",
  "perc.hat16": "busy, driving",
  "perc.rim": "dry, minimal, groovy",
  "perc.keys": "metallic, quirky, sparse",
  "perc.shuffle": "shuffled, groovy, busy",
  "perc.bongos": "latin, groovy, tribal",
  "perc.euclid5": "syncopated, hypnotic, dry",
  "perc.euclid7": "syncopated, busy, hypnotic",
  "lead.acid": "squelchy, hypnotic, driving",
  "lead.arp": "bright, hypnotic",
  "lead.arp3": "hypnotic, rolling, light",
  "lead.melodic": "melodic, emotional, smooth",
  "lead.stabs": "bright, euphoric, punchy",
  "lead.zap": "trippy, energetic",
  "lead.bell": "bright, light, melodic",
  "lead.acidPhryg": "dark, squelchy, twisted",
  "lead.techno": "dark, dubby, minimal",
  "lead.bits": "lo-fi, quirky",
  "lead.chirp": "trippy, playful",
  "lead.soaring": "euphoric, uplifting, melodic",
  "lead.grid": "melodic, hypnotic, deep",
  "lead.vowel": "trippy, dark, weird",
  "lead.rubber": "funky, playful, trippy",
  "lead.squelch": "squelchy, driving, full-on",
  "lead.insect": "alien, twisted, metallic",
  "lead.morph": "hypnotic, evolving, polymetric",
  "lead.chaos": "hypnotic, evolving, unpredictable",
  "lead.piano": "uplifting, classic, bright",
  "lead.organ": "punchy, retro, groovy",
  "pad.chord": "warm, melancholic",
  "pad.prog": "dark, exotic, tense",
  "pad.drone": "dark, deep, ambient",
  "pad.air": "airy, ambient, minimal",
  "pad.sus": "uplifting, hopeful",
  "pad.dark": "dark, tense, ominous",
  "pad.epic": "euphoric, epic, uplifting",
  "pad.supersaw": "euphoric, big, bright",
  "pad.fifths": "open, hollow, hypnotic",
  "pad.deep": "warm, deep, jazzy",
  "pad.grains": "ethereal, vocal, shimmering",
  "pad.glass": "glassy, alien, shimmering",
  "glitch.stutter": "tense, busy",
  "glitch.blips": "playful, sparse",
  "glitch.zips": "energetic, punchy",
  "glitch.crush": "lo-fi, dark",
  "glitch.metal": "metallic, harsh",
  "glitch.ring": "weird, robotic, dark",
  "glitch.crackle": "subtle, textural, minimal",
  "glitch.rise": "rising, energetic",
  "glitch.tape": "dramatic, sparse",
  "glitch.lasers": "trippy, intense, busy",
  "glitch.comb": "metallic, alien, twisted",
};

// Level max: what each sound does in a track, a sentence a model can arrange
// by: its energy, the sections it fits and what it sits well with.
// CHARACTER says how it sounds; this, where it goes.
export const ROLE = {
  "kick.punchy": "the full-on workhorse: mid-high energy, carries grooves and peaks under a rolling bass",
  "kick.long": "a warm, roomy kick for slower, deeper grooves; leaves little space for a busy bass",
  "kick.tok": "a hi-tech click that drives fast, busy tracks; pairs with a jumping FM bass",
  "kick.fullon": "big and round: peak-time energy, under rolling basses and euphoric leads",
  "kick.techno": "a hard 909 for dark, hypnotic grooves; peaks without needing a melody",
  "kick.rumble": "a heavy, rumbling low end for dark, driving techno; best with sparse, dubby parts above",
  "kick.prog": "soft and patient: intros, long grooves and the progressive lift",
  "kick.psytech": "dry and tight, for minimal, hypnotic grooves that build slowly",
  "kick.dark": "a short, sharp tok for dark, fast night tracks; makes room for a busy bass",
  "kick.house": "a round four-on-the-floor for warm, groovy house; relaxed energy",
  "kick.techHouse": "a dry, punchy kick for groovy tech house, under plucked bass and shuffled hats",
  "bass.offbeat": "the lightest bass: one note per beat, for intros, grooves and air",
  "bass.rolling": "the classic psy roll: fills every gap, the engine of grooves and peaks",
  "bass.rollingOct": "a brighter roll that lifts the energy: builds and peaks",
  "bass.gallop": "a bouncing gallop: mid energy, a lighter alternative to the full roll",
  "bass.fm": "a gritty, driving roll for full-on grooves and peaks",
  "bass.prog": "a deep sub on the offbeats, spacious: intros, progressive grooves and breakdowns with a beat",
  "bass.techno": "a dark, syncopated reese that hypnotizes; long grooves and dark peaks",
  "bass.hitech": "fast and twisted: high-energy hi-tech peaks, very busy",
  "bass.phrygian": "a dark, exotic roll that turns on its B-flat: dark grooves and peaks",
  "bass.house": "a funky organ bass that bounces: warm house grooves",
  "bass.techHouse": "short, groovy plucks around the offbeat: tech house grooves and peaks",
  "bass.deep": "round and airy, long notes: deep, laid-back grooves",
  "bass.wavetable": "a biting roll that opens on every note: driving grooves and peaks with edge",
  "perc.hat": "the offbeat open hat: light lift in any section, the first percussion in",
  "perc.chat": "a tight, quiet tick: minimal grooves, intros and breakdowns",
  "perc.shaker": "continuous 16ths that keep things moving: grooves and peaks",
  "perc.clap": "a backbeat on 2 and 4: adds punch to grooves and peaks",
  "perc.snare": "a backbeat with a roll: tension in builds, punch in peaks",
  "perc.ride": "a metallic, driving ride: raises the energy in peaks",
  "perc.toms": "tuned tribal toms with a fill: goa grooves and peaks, busy",
  "perc.hat16": "relentless 16th hats: high energy, builds and peaks",
  "perc.rim": "a dry syncopated rim: groove without weight, minimal or house",
  "perc.keys": "an odd metallic jingle: quirky colour, sparse, any groove",
  "perc.shuffle": "swung hats with a human groove: house and tech house",
  "perc.bongos": "latin bongos: warm, organic groove for house and progressive",
  "perc.euclid5": "an off-grid rim pattern: hypnotic, tribal, minimal grooves",
  "perc.euclid7": "a busier off-grid shaker: hypnotic momentum in grooves and peaks",
  "lead.acid": "the 303 line: hypnotic and driving, grooves and peaks, rises with filter motion",
  "lead.arp": "a bright repeating arpeggio: energy and movement in builds and peaks",
  "lead.arp3": "a light 3-against-4 pluck that drifts: progressive grooves, intros and breakdowns",
  "lead.melodic": "a slow, emotional saw melody: breakdowns and the theme of a track",
  "lead.stabs": "euphoric supersaw chord stabs: peaks and big moments",
  "lead.zap": "falling zaps: trippy, high-energy peaks and hi-tech",
  "lead.bell": "a clear FM bell figure: melodic and light, breakdowns, intros and progressive grooves",
  "lead.acidPhryg": "a darker, twisted 303: dark grooves and night peaks",
  "lead.techno": "a dub techno chord stab with space: minimal, dark grooves",
  "lead.bits": "a lo-fi chiptune line: quirky colour in hi-tech or playful grooves",
  "lead.chirp": "a playful falling chirp on the offbeats: trippy hi-tech grooves",
  "lead.soaring": "a sliding, uplifting melody: the euphoric lift in builds, peaks and breakdowns",
  "lead.grid": "a deep pluck with written-in echo: hypnotic progressive grooves",
  "lead.vowel": "a weird talking lead: trippy, dark grooves and peaks",
  "lead.rubber": "a bendy, funky lead: playful grooves, tech house to hi-tech",
  "lead.squelch": "a squelchy full-on line: driving peaks",
  "lead.insect": "an alien, metallic chatter: dark and hi-tech peaks, twisted",
  "lead.morph": "an evolving polymetric phrase: long hypnotic grooves that never repeat the same way",
  "lead.chaos": "a wandering, unpredictable pluck: hypnotic grooves and strange breakdowns",
  "lead.piano": "classic house piano chords: uplifting, the house peak",
  "lead.organ": "a retro organ stab on the offbeats: groovy house and tech house",
  "pad.chord": "a warm minor chord bed: any section, gentle, breakdowns and intros",
  "pad.prog": "a tense Phrygian move: dark builds and breakdowns",
  "pad.drone": "a low breathing drone: dark intros and breakdowns, or under a minimal groove",
  "pad.air": "tuned wind, barely a pad: airy intros, minimal grooves, space",
  "pad.sus": "a hopeful suspended chord resolving: uplifting builds and breakdowns",
  "pad.dark": "an ominous semitone cluster: dark tension in builds and breakdowns",
  "pad.epic": "the epic i-VI-VII progression: euphoric breakdowns and peaks",
  "pad.supersaw": "a huge trance chord: euphoric peaks and the big breakdown",
  "pad.fifths": "open hollow fifths, no major or minor: hypnotic, fits any mood",
  "pad.deep": "jazzy, warm ninth chords: deep house and laid-back grooves",
  "pad.grains": "an ethereal vocal cloud: intros, breakdowns, dreamy moments",
  "pad.glass": "inharmonic glass bells: alien shimmer for intros, breakdowns and dark grooves",
  "glitch.stutter": "bursts before the kick: tension, builds and busy peaks",
  "glitch.blips": "sparse computer bleeps: playful colour in grooves",
  "glitch.zips": "a zap before every kick: energy in peaks",
  "glitch.crush": "a lo-fi falling crunch: dark grooves",
  "glitch.metal": "harsh metallic hits: dark, industrial peaks",
  "glitch.ring": "a robotic ring-mod voice: weird, dark grooves",
  "glitch.crackle": "quiet digital dust: texture for intros, breakdowns and minimal grooves",
  "glitch.rise": "a rising bwip: lifts builds and peaks",
  "glitch.tape": "a tape stop at the loop's end: drama in builds, sparse",
  "glitch.lasers": "lasers on every offbeat: intense, trippy peaks",
  "glitch.comb": "a bending metallic comb: alien, twisted texture in dark grooves and breakdowns",
};

// What each style is, in the words that make a model arrange it: the genre
// and its signature sounds. en.styles names a style, this says how it goes.
export const GENRE = {
  house:
    "a house track: four-on-the-floor and soulful, a round kick, a funky bass, open hats and claps, piano and organ hooks over warm, jazzy chords; it grooves rather than pounds",
  techhouse:
    "a tech house track: stripped back and groovy, a tight kick and a rolling bass that carry it, shuffled hats and percussion, rubbery or vocal stabs; little melody, all groove",
  techno:
    "a techno track: hypnotic and driving, a booming kick, a dark rumbling bass, repetitive stabs and drones; the tension comes from repetition and texture more than melody",
  progressive:
    "a progressive psytrance track: smooth, deep and melodic, a soft kick and a galloping bass, long builds, arpeggios and soaring leads over epic, emotional pads",
  psytrance:
    "a full-on psytrance track: a punchy kick and a rolling bass between the kicks, acid and arpeggiated leads, energetic, euphoric peaks",
  psytech:
    "a psytech track: tight and minimal, a dry kick and an FM bass, Phrygian acid lines and quirky glitches; darker and sparser than full-on",
  hitech:
    "a hi-tech psytrance track: very fast and twisted, a clicky kick and a busy bass, zapping leads and dense glitches; chaotic and intense",
  goa: "a Goa trance track: the psychedelic sound of the 90s, rolling basses, squelchy acid and exotic melodic riffs, sirens and lasers",
  darkpsy:
    "a dark psytrance track: night-time, twisted and ominous, metallic and crackling textures, dark drones, little melody, relentless",
  all: "an electronic dance track of no one style: every sound is open, so the listener's words pick the genre",
};

const barsOf = (section) => SECTIONS[section].loops.map((n) => n * 2);
const counts = (section, range = countRange) =>
  LOOP_LAYERS.map((l) => {
    const [lo, hi] = range(section, l.id);
    return `${l.id} ${lo === hi ? lo : `${lo}-${hi}`}`;
  }).join(", ");

// What an opening may play and last, past the pilot's shape for its section:
// an intro may float a distant lead over stacked pads and a glitch, bring a
// bass in, leave the kick out, and drift for 16 to 32 bars (autopilot.js
// OPENING_MIX fades them in). SECTIONS stays as it is, so seeds replay.
export const OPENING = {
  intro: { kick: [0, 1], bass: [0, 1], perc: [0, 2], lead: [0, 1], pad: [0, 2], glitch: [0, 1] },
};
export const OPENING_BARS = { intro: [16, 24, 32] };
// The soft swells an opening may start on; no impact or crash out of silence.
export const OPENING_FX = ["fx.sweep", "fx.reverse", "fx.siren"];
const openRange = (section, layerId) => OPENING[section]?.[layerId] ?? countRange(section, layerId);
const openBars = (section) => OPENING_BARS[section] ?? barsOf(section);

// "peak", or "peak; now and then breakdown" where the pilot rarely goes.
function follows(section) {
  const { next, odds } = SECTIONS[section];
  const usual = next.filter((_, i) => !odds || odds[i] >= 0.5);
  const rare = next.filter((id) => !usual.includes(id));
  return `${usual.join(" or ")}${rare.length ? `; now and then ${rare.join(" or ")}` : ""}`;
}

const UNITS = Array.from({ length: MACRO_MAX * 2 + 1 }, (_, i) => i - MACRO_MAX);
const PART_LAYERS = Object.keys(PART_LENGTHS);

const SECTION_LINES = SECTION_IDS.map((s) => `- ${s}: ${barsOf(s).join(" or ")} bars; ${counts(s)}`);

// The low level's: the forms and the rules, in as few words as they take.
const LOW_SYSTEM = [
  "Sections, their lengths in bars and how many sounds each layer plays:",
  ...SECTION_LINES,
  "Usual flow: intro, groove, build, peak, then breakdown or groove, then build again. A breakdown drops the kick and the bass.",
  "Every section plays a lead or a pad. Keep some sounds of the section before and change a layer or two.",
  "You plan one section: which one, its bars and the ids of each layer, only from the lists given. An empty list leaves the layer out.",
  "The listener's wishes come first.",
  "Start the answer with why: a few words.",
].join("\n");

// Level high: the tweaks on top of the macros (dress.js TWEAKS). A function:
// dress.js imports this module through share.js, so CHOICES may not be there yet.
const tweakLine = () => `At this level each dress entry also builds the sound's insert ("" or 0 leaves the factory's): filter (${CHOICES.filter.join(", ")}), cutoff (-${MACRO_MAX} dark to ${MACRO_MAX} bright: where that filter sits), res (-${MACRO_MAX} smooth to ${MACRO_MAX} screaming), sweep (an LFO on the cutoff, one cycle per ${CHOICES.sweep.filter((k) => k !== "off").join(", ")}; or off) with its shape (${CHOICES.shape.join(", ")}), env (a filter envelope on every note: -${MACRO_MAX} closes, ${MACRO_MAX} opens, a pluck or a wah), distortion (${CHOICES.distortion.join(", ")}; drive sets how much), trem (a tremolo, one cycle per ${CHOICES.trem.filter((k) => k !== "off").join(", ")}), autopan (slow, fast) and echo (each note answered ${CHOICES.echo.filter((k) => k !== "off").join(", ")} later; melodic sounds only). Leads and pads take all of it, percussion and glitches all but echo, the bass only a lowpass, cutoff, res, env and a soft or hard distortion, the kick only a soft one; pads take no fold. Distortion is grit, not volume: it plays a little quieter, so use it on one or two sounds at a time. Dress every lead and pad you plan, boldly, so each section sounds its own: an acid lead through a resonant lowpass sweeping over 2 bars, a pad through a slow vowel, a pluck from a closing envelope, a dotted echo on a sparse motif; and a gritty bass in a peak.`;

const keyOf = (style) => {
  const scale = STYLES[style]?.scale;
  return scale ? en.scales[scale] : "A, each sound in its own scale (most in A minor)";
};

/**
 * What the track is, from the settings: `style`'s genre (GENRE, or `genre`,
 * that genre tuned to the wish by tunePrompt), its key and BPM range, the
 * `bpm` it plays at and the listener's `vibe`, their standing wish
 * (planPrompt says when it is fresh).
 */
export function briefOf({ style, bpm, vibe = "", genre = "" }) {
  const range = STYLES[style]?.bpm;
  const lines = [
    `You arrange ${genre || (GENRE[style] ?? GENRE.all)}. It plays live, made of 2-bar loops grouped in sections.`,
    `Tempo: ${Math.round(bpm)} BPM${range ? ` (the style runs ${range[0]}-${range[1]})` : ""}. Key: ${keyOf(style)}.`,
  ];
  if (vibe) lines.push(`The listener's wish for the track: ${JSON.stringify(vibe)}.`);
  return lines.join("\n");
}

// Level max: what the longer description of each sound holds.
export const ROLE_LINE =
  "Each sound also says where it goes: its energy, the sections it fits and what it sits well with. Where the listener described a sound in their own words, those come first: they may have changed it or put their own sample in it, so trust them over its name.";

/**
 * The instructions of an ask: the brief of the track (briefOf), then the
 * rules of `level`: low, mid (the full ones), high (mid's, plus the tweaks)
 * or max (high's, plus each sound's role).
 */
export function systemOf({ level, ...track }) {
  const at = levelOf(level);
  const rules = at === "low" ? LOW_SYSTEM : [SYSTEM, ...(tweaks(at) ? [tweakLine()] : []), ...(tells(at) ? [ROLE_LINE] : [])].join("\n");
  return `${briefOf(track)}\n${rules}`;
}

// The listener's wish, first: in English like every prompt, whatever the
// page's language, and the style's genre rewritten to it, which the brief
// carries in place of GENRE (briefOf). Asked once per style and wish.
const TUNED_MAX = 400;
export const TUNE_SYSTEM = [
  "You prepare the brief an AI follows to arrange an electronic dance track live, out of kick, bass, percussion, leads, pads and glitches.",
  "You get the genre the listener picked, as a phrase that completes \"You arrange ...\", and their wish for the track in their own words, in any language.",
  "vibe: their wish in English, faithful and short: translate it, keep every idea and add none.",
  `genre: the genre rewritten to the wish, in English, in the same shape: what kind of track, a colon, then how it goes (its kick and bass, its percussion, leads and pads, its mood and energy, how it grooves and builds). The wish shapes it boldly, but it stays that genre at its tempo. Name no tempo, key or artist; ${TUNED_MAX} characters at most.`,
].join("\n");

/** What to ask before anything else when there is a `vibe`: it in English, and `style`'s genre tuned to it. */
export function tunePrompt({ style, vibe }) {
  return [`The genre: ${JSON.stringify(GENRE[style] ?? GENRE.all)}.`, `The listener's wish: ${JSON.stringify(vibe)}.`].join("\n");
}

/** The JSON Schema of the tune: the wish in English, then the genre. */
export const tuneSchema = () => ({
  type: "object",
  properties: {
    vibe: { type: "string", maxLength: 200 },
    genre: { type: "string", maxLength: TUNED_MAX },
  },
  required: ["vibe", "genre"],
  additionalProperties: false,
});

const tuned = (value, max) =>
  typeof value === "string"
    ? value
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^["'«“]+|["'»”]+$/g, "")
        .replace(/^you arrange\s+/i, "")
        .replace(/[.\s]+$/, "")
        .slice(0, max)
    : "";

/** The model's tune -> { vibe, genre }, each "" where it gave nothing usable (the listener's words, GENRE). */
export function normalizeTune(raw) {
  const vibe = tuned(raw?.vibe, 200);
  const genre = tuned(raw?.genre, TUNED_MAX);
  return { vibe, genre: genre.length >= 12 ? genre : "" };
}

// The rules, read off SECTIONS, so the model learns the same forms the pilot keeps.
export const SYSTEM = [
  "Sections, their lengths in bars and how many sounds each layer usually plays in them:",
  ...SECTION_LINES,
  "The usual flow is intro, groove, build, peak, then breakdown or groove, then build again; now and then a build teases into a breakdown instead. A peak lands after a build; a breakdown drops the kick and the bass and lets a lead and a pad breathe.",
  "The lead a breakdown plays is the track's theme: it stays through the build and the peak after it.",
  "Every section plays a lead or a pad. With no wishes from the listener, keep some of the sounds of the section before it and change a layer or two at each section: continuity first, contrast from the section's form.",
  "You plan one section, the one after the one playing now or, when some are already planned, after the last of them (or, when asked, the opening the track starts with): which section, its length in bars (one of the lengths that section has) and the sounds of every layer, using only the ids listed for each layer. An empty list leaves that layer out.",
  "Each sound comes with its name, how it is made and its character in a few words: match the listener's words to those.",
  "The listener's wishes come first, before the usual counts and continuity. Leave out every layer that does not fit them (minimal: no pad, little percussion, no glitch; ambient or deep: no kick, long pads; full or euphoric: every layer at its most) and pick the sounds, the section and the length that match their words. A wish they just made, follow boldly, so the change is clearly heard; a standing one already shapes the track: keep to it while the sections still rise and fall.",
  `You may also dress the sounds you plan, in dress: four macros from -${MACRO_MAX} to ${MACRO_MAX}, 0 leaving the sound as it is: tone (dark to bright), length (short to long; drums and glitches), drive (clean to distorted), motion (still to a sweeping filter and phaser; never on kick or bass). A melodic sound may also switch synth within its group ("" keeps it). Dress only the sounds the wish or the section asks for; leave the others out of dress.`,
  `And you may write the melodic parts, in parts, in scale degrees of the key: "1" the root, "8" the octave up, up to "${DEGREES.at(-1)}"; "${REST}" a rest. lead: ${PART_LENGTHS.lead} sixteenths, an 8-step motif and its answer, played motif, motif, motif, answer over the 2 bars (a lead made of chords walks them onto the degrees). pad: the degree of each bar's chord, ${PART_LENGTHS.pad} of them ("1", "6": i to VI). bass: the ${PART_LENGTHS.bass} sixteenths of one beat, repeated under every beat; the first lands on the kick, so "${REST}", "1", "1", "1" rolls between the kicks. A part goes to the sound you plan in that layer; an empty list leaves it as it is, and the theme's always stays.`,
  "Start the answer with why: one short sentence on what you picked and the reason.",
  "Asked for the form of the next track instead, you pick one of the forms given and how long each of its sections lasts.",
].join("\n");

// "kick.dark (Dark tok: 250→62 Hz…; dark, sharp, minimal)", with a copy's
// own name when it has one. With `descriptions` (level max), its role and
// the listener's words for it follow.
function describe(id, names, synths, descriptions) {
  const [name, detail] = en.variants[baseOf(id)] ?? [id, ""];
  const what = isCopy(id) ? `${names[id] ? `${JSON.stringify(names[id])}, ` : ""}a copy of ${name}` : name;
  const character = CHARACTER[baseOf(id)];
  const synth = synths[id] ? `; synth ${synths[id]}` : "";
  const role = descriptions && ROLE[baseOf(id)] ? `; ${ROLE[baseOf(id)]}` : "";
  const own = descriptions?.[id] ? `; the listener says: ${JSON.stringify(descriptions[id])}` : "";
  return `${id} (${what}${detail ? `: ${detail}` : ""}${character ? `; ${character}` : ""}${role}${synth}${own})`;
}

// "kick.dark (dark, sharp, minimal)": the low level's, the character alone.
function brief(id, names) {
  const character = CHARACTER[baseOf(id)];
  const name = isCopy(id) && names[id] ? JSON.stringify(names[id]) : "";
  const what = [name, character].filter(Boolean).join("; ");
  return what ? `${id} (${what})` : id;
}

// "lead.acid tone -1 drive 2 synth acid filter lowpass sweep 2 bars"
const dressLine = ({ id, synth, ...macros }) =>
  [
    id,
    ...MACROS.filter((k) => macros[k]).map((k) => `${k} ${macros[k]}`),
    ...(synth ? [`synth ${synth}`] : []),
    ...TWEAKS.filter((k) => macros[k]).map((k) => `${k} ${macros[k]}`),
  ].join(" ");

// "- groove, 16 bars: kick.long, bass.rolling; no pad", the layers it leaves
// to the pilot unsaid.
function plannedLine({ section, bars, layers }) {
  const ids = Object.values(layers).flat();
  const out = Object.keys(layers).filter((id) => !layers[id].length);
  const what = [ids.join(", "), ...out.map((id) => `no ${id}`)].filter(Boolean).join("; ");
  return `- ${section}${bars ? `, ${bars} bars` : ""}${what ? `: ${what}` : ""}`;
}

// The synth groups the style's melodic sounds can move within.
function synthGroups(lists, style) {
  const groups = new Map();
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    for (const id of poolOf(lists, layer.id, style)) {
      const ids = synthsFor(id);
      if (ids.length < 2) continue;
      groups.set(SYNTHS.find((s) => s.id === ids[0]).group, ids);
    }
  }
  return groups;
}

// Every sound the style lets the model use, by layer, and (where it dresses
// them) the synths the melodic ones can switch to. Described in full (at
// level max with each one's role and the listener's `descriptions`), by
// character alone at the low level, or by id alone.
function soundLines(lists, style, names, synths, { level, describe: told = true, descriptions = {} }) {
  const lines = ["Sounds you can use, by layer:"];
  const own = tells(level) ? descriptions : null;
  const say = !told ? (id) => id : levelOf(level) === "low" ? (id) => brief(id, names) : (id) => describe(id, names, synths, own);
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    lines.push(`${layer.id}: ${poolOf(lists, layer.id, style).map(say).join(told ? "; " : ", ")}`);
  }
  const groups = dresses(level) ? synthGroups(lists, style) : new Map();
  if (groups.size) {
    lines.push("Synths a melodic sound can switch to, by group:");
    for (const [group, ids] of groups) {
      lines.push(`${group}: ${told ? ids.map((id) => `${id} (${en.synths[id].join(": ")})`).join("; ") : ids.join(", ")}`);
    }
  }
  return lines;
}

/**
 * What to ask for the section after the one playing, or after the `planned`
 * ones (normalized plans, in order) when there are some. `sections` are the ones
 * walked so far (the last one plays now, `bars` long) and `sounds`, beside
 * them, what each one opened with; `vibe` is the listener's own words (the
 * brief holds them), said again when `fresh`: no plan has followed them yet; `next`, a section queued by hand, is the
 * one to plan; `theme`, the lead the pilot will hold if what comes is the
 * step after the last section (themeAfter). `dressed` are the plans'
 * dress entries in force (the playing ones are recalled) and `synths` each
 * melodic sound's synth now; `descriptions`, the listener's words for
 * their sounds (level max). `closing` ({ seconds, route }, closingLine)
 * says 🌅 is closing the set, in place of the set's arc; a `next` outro
 * gets what the pilot does with it. `nextBars`, the bars the form gives `next`.
 */
export function planPrompt({
  style,
  lists,
  active,
  sections,
  sounds = [],
  dressed = [],
  synths = {},
  bars,
  vibe = "",
  fresh = false,
  names = {},
  descriptions = {},
  next = null,
  nextBars = null,
  formed = false,
  form = [],
  theme = [],
  planned = [],
  level = LEVEL_DEFAULT,
  describe: told = true,
  set = {},
  closing = null,
}) {
  const low = !dresses(level);
  const now = sections.at(-1);
  const last = planned.at(-1)?.section ?? now;
  const playing = [...new Set(Object.values(active))].sort();
  const lines = [`Sections so far: ${sections.slice(-HISTORY).join(", ")}. Now playing: ${now}, ${bars} bars.`];
  const recalled = sections
    .map((section, i) => ({ section, ids: sounds[i] }))
    .slice(0, -1)
    .slice(-RECALLED)
    .filter(({ ids }) => !low && Array.isArray(ids) && ids.length);
  if (recalled.length) {
    lines.push("What the sections before it opened with:", ...recalled.map(({ section, ids }) => `- ${section}: ${ids.join(", ")}`));
  }
  lines.push(`Sounds playing now: ${playing.length ? playing.join(", ") : "none"}.`);
  const worn = low ? [] : dressed.filter((d) => playing.includes(d.id));
  if (worn.length) lines.push(`How you dressed them: ${worn.map(dressLine).join("; ")}.`);
  if (planned.length) lines.push("Already planned to follow it, in order:", ...planned.map(plannedLine));
  const into = THEME_PATH[last];
  if (theme.length && into && (!next || next === into)) {
    lines.push(`If you plan a ${into}, its lead is the theme, ${theme.join(", ")}: the pilot keeps it there whatever you pick.`);
  }
  lines.push(...soundLines(lists, style, names, synths, { level, describe: told, descriptions }));
  const arc = closing ? closingLine(closing) : setLine(set);
  if (arc) lines.push(arc);
  if (next === OUTRO) lines.push(OUTRO_LINE);
  if (vibe && fresh) {
    lines.push(`The listener just asked for: ${JSON.stringify(vibe)}. That comes first: shape this section to it boldly, so the change is clearly heard, and leave out the layers that do not fit.`);
  } else if (vibe) {
    lines.push("The listener's wish comes first: keep the track true to it and leave out the layers that do not fit, while the sections still rise and fall.");
  }
  if (form.length) lines.push(`After it, the track goes on with: ${form.join(", ")}.`);
  if (next && closing) lines.push(`The closing has ${next} ${planned.length ? `after the planned ${last}` : "next"}: plan that section.`);
  else if (next && formed) {
    const long = nextBars ? `, ${nextBars} bars` : "";
    lines.push(`Your form of the track has ${next}${long} ${planned.length ? `after the planned ${last}` : "next"}: plan that section.`);
  }
  else if (next) lines.push(`The listener queued ${next} ${planned.length ? `after the planned ${last}` : "next"}: plan that section.`);
  else if (planned.length) lines.push(`After the planned ${last}, the usual next is ${follows(last)}. Plan the section after it.`);
  else lines.push(`After the ${now}, the usual next is ${follows(now)}. Plan the next section.`);
  return lines.join("\n");
}

/**
 * What to ask for the opening: the section the track starts with, from
 * silence (`section`), asked before any plan ahead. It is the show's first
 * impression, so it gets more room and time than the pilot's intro
 * (OPENING) and maybe a swell on the 1; the UI lays it over the seed's draw
 * (openWith). `active` is
 * that draw, `vibe` the listener's words; `synths`, `names` and
 * `descriptions` as in
 * planPrompt().
 */
export function openingPrompt({
  style,
  lists,
  section,
  active = {},
  vibe = "",
  names = {},
  descriptions = {},
  synths = {},
  level = LEVEL_DEFAULT,
  describe: told = true,
  set = {},
}) {
  const low = !dresses(level);
  const drawn = [...new Set(Object.values(active))].sort();
  const lines = [
    "This is the opening of the track and of the show: the first thing the audience hears, out of silence. Let it rise slowly and pull them in, in the style's own way, never a jolt.",
    `Plan the ${section} it opens with: ${openBars(section).join(" or ")} bars; ${counts(section, openRange)}.`,
  ];
  if (section === "intro" && low) {
    lines.push("An intro: pads and atmosphere first, maybe a distant lead; the pilot fades the kick and the bass in later, so pick them too (or no kick, for no beat).");
  } else if (section === "intro") {
    lines.push(
      "An intro drifts in like the first track of a set: atmosphere first, deep or airy pads, a subtle glitch texture, at most a distant lead floating a slow motif or a melody that tells a story. The pilot then fades the kick in muffled from 40 % of the way and the bass from halfway, quiet and filtered, opening up little by little, and ends the intro in a drop: the groove explodes with the bass wide open. So pick a kick and a bass for that (a driving one builds best), or leave the kick out for an intro with no beat at all. Take the longest lengths: it has time.",
    );
  }
  lines.push(`The seed drew: ${drawn.length ? drawn.join(", ") : "nothing"}. Keep what serves the opening, change the rest.`);
  lines.push(...soundLines(lists, style, names, synths, { level, describe: told, descriptions }));
  const swells = told ? OPENING_FX.map((id) => `${id} (${en.variants[id].join(": ")})`).join("; ") : OPENING_FX.join(", ");
  lines.push(`fx: a soft swell on the very first beat, or "" for none (usually none): ${swells}.`);
  if (!low) {
    lines.push(
      "Write the parts of the melodic sounds you pick: sparse and slow, long notes and rests, a lead motif that hangs in the air; dress the sounds to the mood (long, with motion, never driven).",
    );
  }
  const arc = setLine(set);
  if (arc) lines.push(arc);
  if (vibe) lines.push(`The listener asked for: ${JSON.stringify(vibe)}. That comes first: open the track on it boldly, and leave out the layers that do not fit.`);
  lines.push(`Plan the opening ${section}.`);
  return lines.join("\n");
}

/**
 * What to ask for the form of the next track: one of FORMS and the bars of
 * each of its sections, after the one playing (`sections` so far, the last
 * one playing) and the ones `coming` already (queued by hand, or a form
 * kept). The set's length picks the form, as a rule. With a `vibe` (the
 * brief holds it), the form follows it.
 */
export function formPrompt({ sections, coming = [], vibe = "", set = {} }) {
  const lines = [`Sections so far: ${sections.slice(-HISTORY).join(", ")}. Now playing: ${sections.at(-1)}.`];
  if (coming.length) lines.push(`Already coming after it, in order: ${coming.join(", ")}.`);
  lines.push(
    "Pick the form of the next track, one of these:",
    ...FORM_IDS.map((id) => `- ${id}: ${FORMS[id].join(", ")}`),
    `Pick it by the length of the set: a set of about 1 hour plays ${FORM_OF_SET[60]} tracks, 2 hours ${FORM_OF_SET[120]}, 3 hours ${FORM_OF_SET[180]}; an open-ended one, any.`,
  );
  const arc = setLine(set);
  if (arc) lines.push(`${arc} Shape the form to that point of the set.`);
  if (vibe) lines.push("Shape the form to the listener's wish too.");
  const lengths = [...new Set(FORMS.long)].map((id) => `${id} ${barsOf(id).join(" or ")}`).join("; ");
  lines.push(`Then give the length of each of its sections in bars, in order, each one of the lengths that section has: ${lengths}.`);
  return lines.join("\n");
}

/** The JSON Schema of a form: why, then which form and the bars of each of its sections. */
export const formSchema = () => ({
  type: "object",
  properties: {
    why: { type: "string", maxLength: WHY_MAX },
    form: { type: "string", enum: FORM_IDS },
    bars: {
      type: "array",
      items: { type: "integer", enum: [...new Set(FORMS.long.flatMap(barsOf))].sort((a, b) => a - b) },
      maxItems: FORM_MAX,
    },
  },
  required: ["why", "form", "bars"],
  additionalProperties: false,
});

/**
 * Anyone's form -> [{ section, loops }]: the form it picks, or the one a set
 * of `minutes` takes when it picks none (FORM_OF_SET), and each section's
 * loops from its bars, or the shortest it lasts (the longest, in a set of
 * 2 hours or more) where those are not one of its lengths.
 */
export function normalizeForm(raw, minutes = 0) {
  const id = isObject(raw) && FORM_IDS.includes(raw.form) ? raw.form : (FORM_OF_SET[minutes] ?? "mid");
  const bars = isObject(raw) && Array.isArray(raw.bars) ? raw.bars : [];
  return FORMS[id].map((section, i) => {
    const lengths = barsOf(section);
    const fallback = minutes >= 120 ? lengths.at(-1) : lengths[0];
    return { section, loops: (lengths.includes(bars[i]) ? bars[i] : fallback) / 2 };
  });
}

// The outro (autopilot.js OUTRO): what the pilot does with it, for the
// plan of it and the closing's.
const OUTRO_BARS = barsOf(OUTRO);
const OUTRO_WHAT = `the outro (${OUTRO_BARS.join(", ")} bars; ${counts(OUTRO)}), which drops in like a peak and goes wild, everything at full and wide open with more percussion and glitch, rolls and FX, for 16 bars or more, then fades out bit by bit over 8 to 16 bars with the lowpass closing, and over its last 4 or 8 bars the whole mix slows to a stop like a vinyl`;
const OUTRO_LINE = `The outro is the last thing the audience hears: ${OUTRO_WHAT}. Pick sounds that carry both: a driving lead and a big pad for the madness, that still say goodbye as they fade (the theme's lead, or a last melody that resolves to the root); the pilot brings the extra percussion and glitch itself. Take the longest lengths unless the set has little time left.`;

/** The line saying the set is closing: `seconds` left at most, the `route` coming (the outro last). */
export function closingLine({ seconds = 0, route = [] } = {}) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `The listener is closing the set: it ends in ${minutes} minute${minutes > 1 ? "s" : ""} at most, after ${route.join(", ")}. Every section left is part of the goodbye: a last peak to remember, then the energy winds down to the end.`;
}

/**
 * What to ask when 🌅 closes the set: the sections before the outro, in
 * order, after the one playing (`sections` so far, `left` bars of it to go)
 * and the one its last loop announced (`coming`), in `room` bars at most
 * (at the shortest lengths) and CLOSE_MAX sections. With a `vibe` (the brief
 * holds it), the closing follows it.
 */
export function closingPrompt({ sections, left, coming = [], room, seconds, vibe = "" }) {
  const now = sections.at(-1);
  const lines = [
    `Sections so far: ${sections.slice(-HISTORY).join(", ")}. Now playing: ${now}, ${left} bars left.`,
    `The listener is closing the set: it must end in ${Math.max(1, Math.ceil(seconds / 60))} minutes at most, and it ends with ${OUTRO_WHAT}.`,
  ];
  if (coming.length) lines.push(`Already coming after it: ${coming.join(", ")}.`);
  lines.push(
    "Close it the way a DJ ends a night: a last peak the crowd remembers, then let it wind down, with a long breakdown or straight into the outro; never a cold stop. No intro.",
    `Lay out the sections between ${coming.length ? `the ${coming.at(-1)} already coming` : `the ${now}`} and the outro, in order: ${CLOSE_MAX} at most, ${room} bars at most in all at their shortest (${PLAN_SECTIONS.map((id) => `${id} ${barsOf(id)[0]}`).join(", ")}). None is fine: the outro comes next.`,
  );
  if (vibe) lines.push("Shape the closing to the listener's wish.");
  return lines.join("\n");
}

/** The JSON Schema of a closing: why, then the sections before the outro. */
export const closingSchema = () => ({
  type: "object",
  properties: {
    why: { type: "string", maxLength: WHY_MAX },
    sections: { type: "array", items: { type: "string", enum: PLAN_SECTIONS }, maxItems: CLOSE_MAX },
  },
  required: ["why", "sections"],
  additionalProperties: false,
});

/** Anyone's closing -> the section ids before the outro that a plan may pick, at most CLOSE_MAX. */
export function normalizeClosing(raw) {
  const given = isObject(raw) && Array.isArray(raw.sections) ? raw.sections : [];
  return given.filter((id) => PLAN_SECTIONS.includes(id)).slice(0, CLOSE_MAX);
}

/**
 * The JSON Schema of an answer: a sentence on why, then the section, its
 * bars, each layer's ids, how to dress them and the melodic parts, all as
 * enums, so a model that decodes against it cannot name what is not there
 * (`next`, queued by hand, is the only section it may name, and `bars`, the
 * form's length for it, the only length). Engines differ in how much of a schema they enforce:
 * normalizePlan() checks it all again, and keeps no `why`. The low level
 * asks for no dress or parts; high, for the tweaks in every dress entry.
 */
export function planSchema({ lists, style, next = null, bars: fixed = null, level = LEVEL_DEFAULT }) {
  if (next === OUTRO) return schemaOf({ lists, style, sections: [OUTRO], bars: OUTRO_BARS, range: countRange, most: [OUTRO], level });
  const sections = PLAN_SECTIONS.includes(next) ? [next] : PLAN_SECTIONS;
  const bars = fixed ? [fixed] : [...new Set(PLAN_SECTIONS.flatMap(barsOf))].sort((a, b) => a - b);
  return schemaOf({ lists, style, sections, bars, range: countRange, most: PLAN_SECTIONS, level });
}

/**
 * The JSON Schema of an opening: a plan for `section` alone, with the room
 * OPENING gives it, its lengths and a swell for its first beat ("" for none).
 */
export function openingSchema({ lists, style, section, level = LEVEL_DEFAULT }) {
  const schema = schemaOf({ lists, style, sections: [section], bars: openBars(section), range: openRange, most: [section], level });
  schema.properties.fx = { type: "string", enum: ["", ...OPENING_FX] };
  schema.required.push("fx");
  return schema;
}

function schemaOf({ lists, style, sections, bars, range, most: over, level }) {
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    const pool = poolOf(lists, layer.id, style);
    if (!pool.length) continue;
    const most = Math.max(...over.map((s) => range(s, layer.id)[1]));
    layers[layer.id] = { type: "array", items: { type: "string", enum: pool }, maxItems: most };
  }
  const plan = {
    type: "object",
    properties: {
      why: { type: "string", maxLength: dresses(level) ? WHY_MAX : WHY_LOW },
      section: { type: "string", enum: sections },
      bars: { type: "integer", enum: bars },
      layers: { type: "object", properties: layers, required: Object.keys(layers), additionalProperties: false },
    },
    required: ["why", "section", "bars", "layers"],
    additionalProperties: false,
  };
  if (!dresses(level)) return plan;
  const ids = Object.values(layers).flatMap((l) => l.items.enum);
  const synths = [...new Set(ids.flatMap(synthsFor))];
  const unit = { type: "integer", enum: UNITS };
  const tweaked = tweaks(level) ? TWEAKS : [];
  const dress = {
    type: "array",
    maxItems: Object.values(layers).reduce((sum, l) => sum + l.maxItems, 0),
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: ids },
        ...Object.fromEntries(MACROS.map((k) => [k, unit])),
        synth: { type: "string", enum: ["", ...synths] },
        ...Object.fromEntries(
          tweaked.map((k) => [k, UNIT_TWEAKS.includes(k) ? unit : { type: "string", enum: ["", ...CHOICES[k]] }]),
        ),
      },
      required: ["id", ...MACROS, "synth", ...tweaked],
      additionalProperties: false,
    },
  };
  const parts = {};
  for (const layer of PART_LAYERS) {
    if (!layers[layer]) continue;
    parts[layer] = { type: "array", items: { type: "string", enum: DEGREES }, maxItems: PART_LENGTHS[layer] };
  }
  Object.assign(plan.properties, {
    dress,
    parts: { type: "object", properties: parts, required: Object.keys(parts), additionalProperties: false },
  });
  plan.required.push("dress", "parts");
  return plan;
}

/**
 * The lead the pilot will hold through the step after the `planned` sections
 * (autopilot.js themeOf), as far as the plans say: `pilot` plays `active` now.
 * A planned breakdown's theme is the lead it names, or none.
 */
export function themeAfter(pilot, active, planned = []) {
  let at = pilot.section;
  let held = at === "breakdown" ? Object.values(active).filter((id) => layerOfVariant(id) === "lead") : at === "build" ? (pilot.theme ?? []) : [];
  for (const { section, layers } of planned) {
    const carried = THEME_PATH[at] === section;
    at = section;
    held = at === "breakdown" ? (layers.lead ?? []) : at === "build" && carried ? held : [];
  }
  return held;
}

/**
 * How many of the plans ahead (`{ plan, queued }`, in order) still hold after
 * the queue changed: the queued sections must be theirs, and past the queue
 * only plans the model picked freely stay (one asked for a section since
 * taken off the queue goes, and everything after it).
 */
export function keptAhead(ahead, queue) {
  const i = ahead.findIndex((e, i) => (i < queue.length ? e.plan.section !== queue[i] : e.queued));
  return i < 0 ? ahead.length : i;
}

/** The model's sentence on its plan, one line and short, or "". */
export const whyOf = (raw) =>
  typeof raw?.why === "string" ? raw.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// The dress entries for sounds the plan names, each with only the macros it
// moves (a synth of the sound's group, whole units within range) and the
// tweaks the sound takes (dress.js fits), in id order.
function cleanDress(raw, layers) {
  if (!Array.isArray(raw)) return [];
  const named = new Set(Object.values(layers).flat());
  const out = new Map();
  for (const d of raw) {
    if (!isObject(d) || typeof d.id !== "string" || !named.has(d.id) || out.has(d.id)) continue;
    const entry = { id: d.id };
    for (const k of MACROS) {
      if (Number.isInteger(d[k]) && d[k] && Math.abs(d[k]) <= MACRO_MAX && moves(d.id, k)) entry[k] = d[k];
    }
    if (typeof d.synth === "string" && synthsFor(d.id).includes(d.synth)) entry.synth = d.synth;
    for (const k of TWEAKS) if (Object.hasOwn(d, k) && fits(d.id, k, d[k])) entry[k] = d[k];
    if (Object.keys(entry).length > 1) out.set(d.id, entry);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// A part per melodic layer the plan names a sound in, its degrees repeated
// to the style's length; one with no note is no part.
function cleanParts(raw, layers) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const layer of PART_LAYERS) {
    const given = Object.hasOwn(raw, layer) ? raw[layer] : null;
    const id = layers[layer]?.[0];
    if (!Array.isArray(given) || !id || defOf(id)?.kind !== "notes") continue;
    const degrees = given.filter((d) => DEGREES.includes(d)).slice(0, PART_LENGTHS[layer]);
    if (!degrees.some((d) => d !== REST)) continue;
    out[layer] = Array.from({ length: PART_LENGTHS[layer] }, (_, i) => degrees[i % degrees.length]);
  }
  return out;
}

/**
 * Anyone's answer -> { section, bars, layers, dress?, parts? } or null. The section must be
 * one a plan may pick; `bars` that the section cannot last, nor the
 * listener set by hand (BARS_BY_HAND), turn null (the pilot draws a length,
 * or takes the form's); a layer keeps only ids in its pool, at most as many
 * as the section plays. Fewer than the section usually plays is the plan's
 * call, down to none: that is how a vibe leaves a layer out (the pilot still
 * plays a lead or a pad). A layer named with nothing usable left (ids that
 * are all foreign) drops out and the pilot draws it. `dress` and `parts` only
 * reach the sounds the plan names (cleanDress, cleanParts). Idempotent: a normalized
 * plan comes back the same, which is what lets a share link replay one.
 */
export function normalizePlan(raw, { lists, style }) {
  if (!isObject(raw)) return null;
  const section = PLAN_SECTIONS.find((id) => id === raw.section);
  if (!section) return null;
  return cleanPlan(raw, { lists, style }, section, [...barsOf(section), ...BARS_BY_HAND], countRange);
}

/**
 * Anyone's outro -> { section, bars, layers, dress?, parts? } or null:
 * normalizePlan() for the outro, which no other plan may pick. Idempotent too.
 */
export function normalizeOutro(raw, { lists, style }) {
  if (!isObject(raw) || raw.section !== OUTRO) return null;
  return cleanPlan(raw, { lists, style }, OUTRO, OUTRO_BARS, countRange);
}

/**
 * Anyone's opening -> { section, bars, layers, dress?, parts?, fx? } or
 * null: normalizePlan() for `section` only, the section the track starts
 * with, within OPENING, plus a swell of OPENING_FX. Idempotent too.
 */
export function normalizeOpening(raw, { lists, style, section }) {
  if (!isObject(raw) || raw.section !== section || !SECTIONS[section]) return null;
  const plan = cleanPlan(raw, { lists, style }, section, openBars(section), openRange);
  return OPENING_FX.includes(raw.fx) ? { ...plan, fx: raw.fx } : plan;
}

/**
 * The mix an opening (normalizeOpening) starts with: the seed's draw
 * (`active`), with each layer the opening names set to its sounds still in
 * the pool. Draws nothing, so a link replays it. A lead or a pad always
 * plays: one the opening left out comes back from the draw.
 */
export function openWith(active, opening, lists, style) {
  const out = {};
  for (const [lane, id] of Object.entries(active)) {
    if (!Object.hasOwn(opening.layers, layerOfVariant(id))) out[lane] = id;
  }
  for (const [layerId, ids] of Object.entries(opening.layers)) {
    const pool = poolOf(lists, layerId, style);
    for (const id of ids) if (pool.includes(id)) out[laneKey(layerById(layerId), id)] = id;
  }
  const melodic = (mix) => Object.values(mix).some((id) => ["lead", "pad"].includes(layerOfVariant(id)));
  if (melodic(out)) return out;
  for (const [lane, id] of Object.entries(active)) if (["lead", "pad"].includes(layerOfVariant(id))) out[lane] = id;
  return out;
}

function cleanPlan(raw, { lists, style }, section, lengths, range) {
  const bars = lengths.includes(raw.bars) ? raw.bars : null;
  const given = raw.layers && typeof raw.layers === "object" && !Array.isArray(raw.layers) ? raw.layers : {};
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id) || !Object.hasOwn(given, layer.id) || !Array.isArray(given[layer.id])) continue;
    const pool = poolOf(lists, layer.id, style);
    const hi = range(section, layer.id)[1];
    const ids = [...new Set(given[layer.id].filter((id) => typeof id === "string" && pool.includes(id)))].slice(0, hi);
    if (ids.length || !given[layer.id].length) layers[layer.id] = ids;
  }
  const dress = cleanDress(raw.dress, layers);
  const parts = cleanParts(raw.parts, layers);
  return {
    section,
    bars,
    layers,
    ...(dress.length ? { dress } : {}),
    ...(Object.keys(parts).length ? { parts } : {}),
  };
}

/**
 * A share link's plans: one entry per section of the run (null where the
 * section had none), at most PLAN_MAX. Each entry still goes through
 * normalizePlan() when its section comes.
 */
export function readPlans(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, PLAN_MAX).map((p) => (p && typeof p === "object" && !Array.isArray(p) ? p : null));
}
