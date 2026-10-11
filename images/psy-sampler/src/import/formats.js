// Every extension the importer knows, in one place: gather.js sorts files by
// these, the file dialog offers them, and the panel's "Supported formats"
// lists them, so what the page says it reads is what it reads. Each group is
// [extension, app]: the app names the program behind it, when there is one.

export const FORMATS = {
  // Decoded by the browser or by pcm.js.
  audio: [
    "wav", "wave", "bwf", "rf64", "aif", "aiff", "aifc", "caf", "au", "snd", "flac",
    "mp3", "ogg", "oga", "opus", "m4a", "mp4", "aac", "webm", "weba",
  ].map((ext) => [ext, null]),
  // Zips, under their own name or another one.
  archives: [
    ["zip", null],
    ["multisample", "Bitwig"],
    ["xrni", "Renoise"],
    ["xrns", "Renoise"],
    ["dslibrary", "Decent Sampler"],
  ],
  // Banks: every sample in them is a candidate of its own.
  instruments: [
    ["sf2", "SoundFont"],
    ["sf3", "SoundFont"],
  ],
  // Point at samples by path: they need their folder in the same selection.
  projects: [
    ["als", "Ableton Live"],
    ["alc", "Ableton Live"],
    ["adg", "Ableton Live"],
    ["adv", "Ableton Live"],
    ["sfz", "SFZ"],
    ["dspreset", "Decent Sampler"],
    ["rpp", "REAPER"],
  ],
  // Closed formats: no way in without the vendor's code, so the message says where to export from.
  closed: [
    ["rx2", "ReCycle (REX)"], ["rex", "ReCycle (REX)"], ["rcy", "ReCycle (REX)"],
    ["nki", "Kontakt"], ["nkm", "Kontakt"], ["nkb", "Kontakt"], ["nkx", "Kontakt"], ["nkc", "Kontakt"], ["ncw", "Kontakt"], ["nicnt", "Kontakt"],
    ["rfl", "Reason"], ["reason", "Reason"], ["rns", "Reason"],
    ["flp", "FL Studio"],
    ["exs", "Logic"], ["logicx", "Logic"],
    ["cpr", "Cubase"],
    ["ptx", "Pro Tools"], ["ptf", "Pro Tools"],
    ["bwproject", "Bitwig"], ["bwpreset", "Bitwig"],
    ["mxprj", "Maschine"], ["mxgrp", "Maschine"], ["mxsnd", "Maschine"],
    ["alp", "Ableton Live"],
  ],
};

const set = (group) => new Set(FORMATS[group].map(([ext]) => ext));
const map = (group) => Object.fromEntries(FORMATS[group]);

export const AUDIO_EXTS = set("audio");
export const ARCHIVE_EXTS = set("archives");
export const INSTRUMENT_EXTS = set("instruments");
export const PROJECT_APPS = map("projects");
export const CLOSED = map("closed");

/** What a file is by its extension alone: audio | zip | sf2 | project | closed | null. */
export function kindOf(ext) {
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ARCHIVE_EXTS.has(ext)) return "zip";
  if (INSTRUMENT_EXTS.has(ext)) return "sf2";
  if (Object.hasOwn(PROJECT_APPS, ext)) return "project";
  if (Object.hasOwn(CLOSED, ext)) return "closed";
  return null;
}

/** The file dialog's accept list: everything readable (closed formats left out). */
export const ACCEPT = [
  "audio/*",
  ...["audio", "archives", "instruments", "projects"].flatMap((group) => FORMATS[group].map(([ext]) => `.${ext}`)),
].join(",");
