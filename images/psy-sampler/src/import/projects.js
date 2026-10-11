// Project and instrument files that point at samples instead of holding
// them: Ableton Live sets, clips and presets (.als .alc .adg .adv, gzipped
// XML), SFZ, Decent Sampler (.dspreset) and REAPER (.rpp). A browser can't
// follow a path on disk, so these only say WHICH files to take (and, for
// Ableton's Simpler/Sampler, which slice of each) from what was selected
// with them: the project folder, or the files themselves.
//
// The Ableton XML is not a published format; this reads what Live 9-12
// write: <SampleRef><FileRef> with <Path>/<RelativePath Value> (Live 11+) or
// <RelativePathElement Dir> + <Name> (earlier), and <SampleStart>/<SampleEnd>
// in frames of the file inside a <MultiSamplePart>.

import { ascii, baseName, extOf, inflate } from "./bytes.js";

const MAX_XML = 256 * 2 ** 20;

// Extensions a sample reference can end in (anything else is not audio we import).
export const AUDIO_EXTS = new Set([
  "wav", "wave", "bwf", "rf64", "aif", "aiff", "aifc", "caf", "au", "snd", "flac",
  "mp3", "ogg", "oga", "opus", "m4a", "mp4", "aac", "webm", "weba",
]);

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e] ?? m;
    return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });

const value = (xml, tag) => {
  const m = new RegExp(`<${tag} Value="([^"]*)"`).exec(xml);
  return m ? unescapeXml(m[1]) : null;
};

const slash = (path) => path.replace(/\\/g, "/");

// The file a <SampleRef> points at, as "dir/dir/name.ext" (as relative as Live kept it).
function fileRef(sampleRef) {
  const xml = /<FileRef\b[^>]*>([\s\S]*?)<\/FileRef>/.exec(sampleRef)?.[1] ?? "";
  const path = value(xml, "RelativePath") || value(xml, "Path");
  if (path) return slash(path);
  const name = value(xml, "Name");
  if (!name) return null;
  const dirs = [...(/<RelativePath>([\s\S]*?)<\/RelativePath>/.exec(xml)?.[1] ?? "").matchAll(/Dir="([^"]*)"/g)];
  return [...dirs.map((m) => unescapeXml(m[1])), name].join("/");
}

/** Ableton Live XML -> [{ path, name?, region? }]; region = { start, end, rate } in the file's frames. */
export function abletonRefs(xml) {
  // Simpler/Sampler zones first: their slice of the file, and the zone's name.
  const parts = [...xml.matchAll(/<MultiSamplePart\b[\s\S]*?<\/MultiSamplePart>/g)].map((m) => ({ from: m.index, to: m.index + m[0].length, xml: m[0] }));
  const refs = [];
  for (const m of xml.matchAll(/<SampleRef\b[^>]*>([\s\S]*?)<\/SampleRef>/g)) {
    const path = fileRef(m[1]);
    if (!path) continue;
    const part = parts.find((p) => m.index >= p.from && m.index < p.to);
    const ref = { path };
    if (part) {
      const head = part.xml.slice(0, part.xml.search(/<SampleRef\b/));
      const name = value(head, "Name");
      if (name) ref.name = name;
      const start = Number(value(head, "SampleStart"));
      const end = Number(value(head, "SampleEnd"));
      const rate = Number(value(m[1], "DefaultSampleRate"));
      const duration = Number(value(m[1], "DefaultDuration"));
      // Only a real slice: the whole file plays as is.
      if (rate > 0 && end > start && start >= 0 && (start > 0 || (duration > 0 && end < duration - 1))) ref.region = { start, end, rate };
    }
    refs.push(ref);
  }
  return refs;
}

/** SFZ: every sample= opcode, under default_path= when there is one. */
export function sfzRefs(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Values may hold spaces: they run to the next opcode, header or line end.
  const opcode = (name) => new RegExp(`\\b${name}=(.+?)(?=\\s+[\\w$]+=|\\s*<|\\s*$)`, "gm");
  const base = [...clean.matchAll(opcode("default_path"))].pop()?.[1].trim() ?? "";
  return [...clean.matchAll(opcode("sample"))].map((m) => ({ path: slash(base + m[1].trim()) }));
}

/** Decent Sampler: <sample path="…">. */
export const decentRefs = (xml) => [...xml.matchAll(/<sample\b[^>]*?\bpath="([^"]*)"/g)].map((m) => ({ path: slash(unescapeXml(m[1])) }));

/** REAPER: the FILE line of each <SOURCE …> block. */
export const reaperRefs = (text) => [...text.matchAll(/^\s*FILE\s+(?:"([^"]*)"|(\S+))/gm)].map((m) => ({ path: slash(m[1] ?? m[2]) }));

const PROJECT_EXTS = new Set(["als", "alc", "adg", "adv", "sfz", "dspreset", "rpp"]);

/** Worth reading as a project: by extension, or (picked directly) gzip / XML. */
export const isProject = (name, head = null) =>
  PROJECT_EXTS.has(extOf(name)) || (head !== null && ((head[0] === 0x1f && head[1] === 0x8b) || ascii(head, 0, 5) === "<?xml"));

const APPS = { als: "Ableton Live", alc: "Ableton Live", adg: "Ableton Live", adv: "Ableton Live", sfz: "SFZ", dspreset: "Decent Sampler", rpp: "REAPER" };

/**
 * A project's bytes -> { app, refs } (refs to audio files only), or null when
 * it isn't one of these.
 */
export async function projectRefs(name, bytes) {
  let data = bytes;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = await inflate(data, "gzip", MAX_XML);
    } catch {
      return null; // corrupt, or a gzip bomb
    }
  }
  const text = new TextDecoder().decode(data.subarray(0, MAX_XML));
  let app = APPS[extOf(name)] ?? null;
  let refs;
  if (/<Ableton\b/.test(text.slice(0, 4096))) {
    app = "Ableton Live";
    refs = abletonRefs(text);
  } else if (/<DecentSampler\b/.test(text.slice(0, 4096))) {
    app = "Decent Sampler";
    refs = decentRefs(text);
  } else if (/^\s*<REAPER_PROJECT\b/.test(text)) {
    app = "REAPER";
    refs = reaperRefs(text);
  } else if (app === "SFZ") refs = sfzRefs(text);
  else return null;
  return { app, refs: refs.filter((r) => AUDIO_EXTS.has(extOf(r.path))).map((r) => ({ ...r, file: baseName(r.path) })) };
}
