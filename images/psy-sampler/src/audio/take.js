// A live recording of the output. Blocks come in as Float32 channels; the
// take starts on the first audible sample, encodes 24-bit PCM as it goes (so
// it holds about the file's size, not the floats) and ends at `maxSeconds`.
// finish() seals it into a .wav with the silence after the last sound cut.
// Pure apart from Blob, so it is tested without audio.
import { PAD_SECONDS, SILENCE, pcm24, wavHeader } from "./wav.js";

// Encoded PCM is folded into a Blob every this many bytes: a browser can page
// a big Blob out to disk, a pile of typed arrays stays on the heap.
const SEAL_BYTES = 16 << 20;
const BYTES = 3;

const loud = (block, i) => block.some((data) => Math.abs(data[i]) > SILENCE);

export function createTake({ sampleRate, channelCount = 2, maxSeconds }) {
  const maxFrames = Math.round(maxSeconds * sampleRate);
  const sealed = []; // Blobs, in order
  let open = []; // Uint8Arrays not sealed yet
  let openBytes = 0;
  let frames = 0;
  let lastLoud = -1; // frame index, within the take, of the last audible sample
  let started = false;

  function push(block) {
    const length = block[0].length;
    let from = 0;
    if (!started) {
      while (from < length && !loud(block, from)) from++;
      if (from === length) return;
      started = true;
    }
    const to = Math.min(length, from + maxFrames - frames);
    if (to <= from) return;
    for (let i = to - 1; i >= from; i--) {
      if (loud(block, i)) {
        lastLoud = frames + i - from;
        break;
      }
    }
    const pcm = pcm24(block, from, to);
    open.push(pcm);
    openBytes += pcm.length;
    frames += to - from;
    if (openBytes >= SEAL_BYTES) {
      sealed.push(new Blob(open));
      open = [];
      openBytes = 0;
    }
  }

  // The .wav as a Blob, and its length in seconds; null if nothing sounded.
  function finish() {
    if (!started) return null;
    const end = Math.min(frames, lastLoud + 1 + Math.round(PAD_SECONDS * sampleRate));
    const data = new Blob([...sealed, ...open]).slice(0, end * channelCount * BYTES);
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
