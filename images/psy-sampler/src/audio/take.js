// A live recording of the output. Blocks come in as Float32 channels; the
// take starts on the first audible sample, encodes 24-bit PCM as it goes (so
// it holds about the file's size, not the floats) and ends at `maxSeconds`.
// finish() seals it into a .wav with the silence after the last sound cut.
// A microphone is never digitally silent: it passes a `threshold` over its
// noise floor, and a `preroll` keeps the start of the attack under it.
// Pure apart from Blob, so it is tested without audio.
import { PAD_SECONDS, SILENCE, pcm24, wavHeader } from "./wav.js";

// Encoded PCM is folded into a Blob every this many bytes: a browser can page
// a big Blob out to disk, a pile of typed arrays stays on the heap.
const SEAL_BYTES = 16 << 20;
const BYTES = 3;

/** Encoded PCM as it comes, held as Blobs: add(bytes), then blob() of it all. */
export function createPcmStore() {
  const sealed = [];
  let open = [];
  let openBytes = 0;
  return {
    add(pcm) {
      open.push(pcm);
      openBytes += pcm.length;
      if (openBytes < SEAL_BYTES) return;
      sealed.push(new Blob(open));
      open = [];
      openBytes = 0;
    },
    blob: () => new Blob([...sealed, ...open]),
  };
}

export function createTake({ sampleRate, channelCount = 2, maxSeconds, threshold = SILENCE, preroll = 0 }) {
  const maxFrames = Math.round(maxSeconds * sampleRate);
  const prerollFrames = Math.round(preroll * sampleRate);
  const loud = (block, i) => block.some((data) => Math.abs(data[i]) > threshold);
  const store = createPcmStore();
  let frames = 0;
  let lastLoud = -1; // frame index, within the take, of the last audible sample
  let started = false;
  let before = null; // the last block heard before the take started

  function write(block, from, end) {
    const to = Math.min(end, from + maxFrames - frames);
    if (to <= from) return;
    for (let i = to - 1; i >= from; i--) {
      if (loud(block, i)) {
        lastLoud = frames + i - from;
        break;
      }
    }
    store.add(pcm24(block, from, to));
    frames += to - from;
  }

  function push(block) {
    const length = block[0].length;
    if (started) return write(block, 0, length);
    let at = 0;
    while (at < length && !loud(block, at)) at++;
    if (at === length) {
      before = block;
      return;
    }
    started = true;
    const lead = Math.min(before?.[0].length ?? 0, Math.max(0, prerollFrames - at));
    if (lead) write(before, before[0].length - lead, before[0].length);
    before = null;
    write(block, Math.max(0, at - prerollFrames), length);
  }

  // The .wav as a Blob, and its length in seconds; null if nothing sounded.
  function finish() {
    if (!started) return null;
    const end = Math.min(frames, lastLoud + 1 + Math.round(PAD_SECONDS * sampleRate));
    const data = store.blob().slice(0, end * channelCount * BYTES);
    return {
      blob: new Blob([wavHeader(sampleRate, channelCount, end), data], { type: "audio/wav" }),
      seconds: end / sampleRate,
    };
  }

  return {
    push,
    finish,
    started: () => started,
    full: () => frames >= maxFrames,
    seconds: () => frames / sampleRate,
  };
}
