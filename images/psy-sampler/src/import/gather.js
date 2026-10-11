// What a selection (files, a dropped folder, a zip…) holds for the sample
// library: a flat list of candidates, each loaded only when it's previewed or
// uploaded. Archives open up (a zip inside a zip too), SoundFonts give one
// candidate per sample, and project files (Ableton, SFZ, Decent Sampler,
// REAPER) mark the candidates they use, add the slices Ableton's Simpler
// plays, and report the files they point at that weren't selected.
//
// Inside folders and archives, the extension decides what a file is; the
// first bytes are read only when it says nothing. Clutter (.asd analysis
// files, __MACOSX, artwork, docs) is skipped without a word.

import { TooBig, ascii, baseName, extOf, readBlob, stem } from "./bytes.js";
import { isPlainWav } from "./pcm.js";
import { AUDIO_EXTS, CLOSED, kindOf } from "./formats.js";
import { isProject, projectRefs } from "./projects.js";
import { isSoundfont, soundfontSamples } from "./soundfont.js";
import { isZip, zipEntries } from "./zip.js";

export const MAX_SOURCE_BYTES = 64 * 2 ** 20; // one audio file, read whole to decode
const MAX_NESTED_BYTES = 512 * 2 ** 20; // a zip or SoundFont inside a zip, read whole
const MAX_PROJECT_BYTES = 64 * 2 ** 20;
const MAX_DEPTH = 2;
export const MAX_CANDIDATES = 500;

// What sample packs and project folders carry besides audio: never a candidate.
const NOT_AUDIO = new Set([
  "txt", "md", "rtf", "pdf", "doc", "docx", "html", "htm", "url", "nfo", "json", "ini", "cfg", "log",
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "svg", "mid", "midi", "exe", "dmg", "app", "db",
]);

const EBML = [0x1a, 0x45, 0xdf, 0xa3];

/** true when the first bytes are a format something here (or the browser) decodes. */
export function looksLikeAudio(head) {
  const tag = ascii(head, 0, 4);
  if (["RIFF", "RF64", "BW64"].includes(tag)) return ascii(head, 8, 12) === "WAVE";
  if (tag === "FORM") return ["AIFF", "AIFC"].includes(ascii(head, 8, 12));
  if (["caff", ".snd", "fLaC", "OggS"].includes(tag) || ascii(head, 4, 8) === "ftyp" || ascii(head, 0, 3) === "ID3") return true;
  if (EBML.every((b, i) => head[i] === b)) return true;
  return head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
}

const has = (bytes, text) => {
  const first = text.charCodeAt(0);
  for (let i = bytes.indexOf(first); i >= 0 && i <= bytes.length - text.length; i = bytes.indexOf(first, i + 1)) {
    if ([...text].every((c, k) => bytes[i + k] === c.charCodeAt(0))) return true;
  }
  return false;
};

/**
 * Formats every browser decodes, which can be stored as they came: plain
 * WAV, FLAC, MP3 and AAC/M4A (not ALAC). The rest (AIFF and CAF: Safari
 * only; Ogg/WebM: not in every Safari; anything this page decoded itself)
 * goes up as WAV, so the sample plays wherever its owner signs in.
 */
export function universal(bytes) {
  const tag = ascii(bytes, 0, 4);
  if (tag === "RIFF") return isPlainWav(bytes);
  if (tag === "fLaC" || ascii(bytes, 0, 3) === "ID3") return true;
  if (ascii(bytes, 4, 8) === "ftyp") return !has(bytes, "alac");
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

const fold = (s) => s.normalize("NFC").toLowerCase();

// Trailing path segments two paths share: how sure a reference is of a file.
function shared(a, b) {
  const x = fold(a).split("/");
  const y = fold(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}

const skip = (path) => {
  const name = baseName(path);
  return name.startsWith("._") || name === ".DS_Store" || /(^|\/)__MACOSX\//.test(path) || extOf(name) === "asd";
};

/**
 * inputs: [{ file: Blob, path }] (path: where it sits in what was picked).
 * -> { candidates, projects, missing, closed, unreadable, more }
 * candidate: { key, name, origin, size, used, region?, load() -> { bytes } | { pcm } }
 */
export async function gather(inputs) {
  const audio = [];
  const projects = [];
  const closed = [];
  const unreadable = [];

  // An item: { name, path, size, picked, blob?, read(max) }. A loose file has a blob;
  // a zip entry only reads whole.
  async function visit(item, depth) {
    if (skip(item.path)) return;
    const ext = extOf(item.name);
    let kind = kindOf(ext);
    if (kind === "closed") kind = null; // unless the bytes say otherwise (an .alp that is a zip)
    if (!kind && item.blob && !NOT_AUDIO.has(ext)) {
      const head = await readBlob(item.blob, 0, 64);
      if (isZip(head)) kind = "zip";
      else if (isSoundfont(head)) kind = "sf2";
      else if (looksLikeAudio(head)) kind = "audio";
      else if (item.picked && isProject(item.name, head)) kind = "project";
    }
    if (!kind && Object.hasOwn(CLOSED, ext)) kind = "closed";
    if (!kind && item.picked && NOT_AUDIO.has(ext)) unreadable.push({ name: item.path, why: "format" });
    // Picked by hand and still unknown: let the browser try it.
    else if (!kind && item.picked) kind = "audio";

    try {
      if (kind === "audio") {
        audio.push({
          key: item.path,
          path: item.path,
          name: stem(item.name),
          origin: item.path,
          size: item.size,
          used: false,
          load: async () => ({ bytes: await item.read(MAX_SOURCE_BYTES) }),
        });
      } else if (kind === "zip" && depth < MAX_DEPTH) {
        const blob = item.blob ?? new Blob([await item.read(MAX_NESTED_BYTES)]);
        for (const entry of await zipEntries(blob)) {
          const path = `${item.path}/${entry.name}`;
          if (entry.problem) {
            if (!skip(path) && AUDIO_EXTS.has(extOf(entry.name))) unreadable.push({ name: path, why: entry.problem });
            continue;
          }
          await visit({ name: baseName(entry.name), path, size: entry.size, picked: false, read: entry.read }, depth + 1);
        }
      } else if (kind === "sf2") {
        const blob = item.blob ?? new Blob([await item.read(MAX_NESTED_BYTES)]);
        for (const [i, s] of (await soundfontSamples(blob)).entries()) {
          audio.push({
            key: `${item.path}#${i}`,
            path: `${item.path}/${s.name}`,
            name: s.name || `${stem(item.name)} ${i + 1}`,
            origin: `${item.path} › ${s.name}`,
            size: s.frames * s.channelCount * 2,
            used: false,
            load: s.load,
          });
        }
      } else if (kind === "project") {
        // Live keeps its backups next to the set; they'd only add stale references.
        if (!item.picked && /(^|\/)Backup\//.test(item.path)) return;
        const found = await projectRefs(item.name, await item.read(MAX_PROJECT_BYTES));
        if (found) projects.push({ name: item.path, ...found });
        else if (item.picked) unreadable.push({ name: item.path, why: "format" });
      } else if (kind === "closed" && item.picked) {
        closed.push({ name: item.path, app: CLOSED[ext] });
      }
    } catch (err) {
      unreadable.push({ name: item.path, why: err instanceof TooBig ? "tooBig" : "format" });
    }
  }

  for (const { file, path = file.name } of inputs) {
    await visit(
      {
        name: baseName(path),
        path,
        size: file.size,
        // A folder's contents are not "picked": its clutter is skipped quietly.
        picked: !path.includes("/"),
        blob: file,
        read: async (max) => {
          if (file.size > max) throw new TooBig();
          return readBlob(file);
        },
      },
      0,
    );
  }

  // What the projects use: the files they name, the slices they play, what's missing.
  const byFile = new Map();
  for (const c of audio) {
    const k = fold(baseName(c.path));
    byFile.set(k, [...(byFile.get(k) ?? []), c]);
  }
  const used = [];
  const slices = new Map();
  const missing = new Set();
  for (const project of projects) {
    project.found = 0;
    for (const ref of project.refs) {
      const list = byFile.get(fold(ref.file));
      if (!list) {
        missing.add(ref.file);
        continue;
      }
      project.found++;
      const match = list.reduce((best, c) => (shared(c.path, ref.path) > shared(best.path, ref.path) ? c : best));
      if (!ref.region) {
        if (!match.used) used.push(match);
        match.used = true;
        continue;
      }
      const key = `${match.key}@${ref.region.start}-${ref.region.end}`;
      if (slices.has(key)) continue;
      const slice = { ...match, key, name: ref.name ?? match.name, region: ref.region, used: true };
      slices.set(key, slice);
      used.push(slice);
    }
  }
  // Slices of one file sharing a name get numbered.
  const names = new Map();
  for (const s of slices.values()) names.set(s.name, (names.get(s.name) ?? 0) + 1);
  const seen = new Map();
  for (const s of slices.values()) {
    if (names.get(s.name) < 2) continue;
    seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
    s.name = `${s.name} ${seen.get(s.name)}`;
  }

  const all = [...used, ...audio.filter((c) => !c.used)];
  return {
    candidates: all.slice(0, MAX_CANDIDATES),
    more: Math.max(0, all.length - MAX_CANDIDATES),
    projects: projects.map(({ name, app, refs, found }) => ({ name, app, refs: refs.length, found })),
    missing: [...missing],
    closed,
    unreadable,
  };
}
