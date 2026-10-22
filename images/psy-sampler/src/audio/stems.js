// A live recording of every stem at once, for a DAW. Blocks come in from one
// tap (engine.tapStems), so the stems stay sample-aligned, each with the
// context frame it starts on; the take keeps what follows `from`, the frame
// startAt() gives it (a bar line). Each stem is encoded 24-bit from the block
// it first sounds in: the silence before is counted, not stored, so a layer
// that never plays costs nothing. finish() ends every stem on the same frame,
// a short pad after the last sound in any of them, so files dropped on a
// DAW's tracks at the same bar line up. Pure apart from Blob, so it is tested
// without audio.
import { PAD_SECONDS, SILENCE, pcm24, wavHeader } from "./wav.js";
import { createPcmStore } from "./take.js";

const FRAME_BYTES = 2 * 3; // stereo, 24-bit

// `bytes` of zeros, out of one second of them: a long silence costs one second.
function silence(second, bytes) {
  const parts = Array(Math.floor(bytes / second.size)).fill(second);
  return [...parts, second.slice(0, bytes % second.size)];
}

export function createStemsTake({ sampleRate, names, maxSeconds }) {
  const maxFrames = Math.round(maxSeconds * sampleRate);
  const stems = names.map((id) => ({ id, store: null, lead: 0, lastLoud: -1 }));
  let from = null; // the context frame the take starts on
  let frames = 0;
  let before = null; // the last block heard before `from` was known

  function write(channels, start, end) {
    const to = Math.min(end, start + maxFrames - frames);
    if (to <= start) return;
    stems.forEach((stem, i) => {
      const pair = [channels[2 * i], channels[2 * i + 1]];
      for (let j = to - 1; j >= start; j--) {
        if (Math.abs(pair[0][j]) > SILENCE || Math.abs(pair[1][j]) > SILENCE) {
          stem.lastLoud = frames + j - start;
          break;
        }
      }
      if (!stem.store && stem.lastLoud < 0) {
        stem.lead += to - start;
        return;
      }
      stem.store ??= createPcmStore();
      stem.store.add(pcm24(pair, start, to));
    });
    frames += to - start;
  }

  // A block's frames from the next one the take needs; a gap (blocks lost
  // before the start) is written as silence, so later frames keep their place.
  function take(channels, at) {
    const next = from + frames;
    const length = channels[0].length;
    if (at > next) {
      const gap = Array.from(channels, () => new Float32Array(at - next));
      write(gap, 0, at - next);
    }
    write(channels, Math.max(0, from + frames - at), length);
  }

  /** A block of every stem, [left0, right0, left1, ...], starting on context frame `at`. */
  function push(channels, at) {
    if (from === null) {
      before = { channels, at };
      return;
    }
    take(channels, at);
  }

  /** The take starts on context frame `frame`; blocks before it are dropped. */
  function startAt(frame) {
    if (from !== null) return;
    from = frame;
    if (before && before.at + before.channels[0].length > frame) take(before.channels, before.at);
    before = null;
  }

  /** { stems: [{ id, blob }] of the stems that sounded, seconds }, or null if none did. */
  function finish() {
    const last = Math.max(...stems.map((s) => s.lastLoud));
    if (last < 0) return null;
    const end = Math.min(frames, last + 1 + Math.round(PAD_SECONDS * sampleRate));
    const second = new Blob([new Uint8Array(sampleRate * FRAME_BYTES)]);
    const sounded = stems.filter((s) => s.lastLoud >= 0);
    return {
      stems: sounded.map(({ id, store, lead }) => {
        const quiet = Math.min(lead, end);
        const data = store.blob().slice(0, (end - quiet) * FRAME_BYTES);
        const parts = [wavHeader(sampleRate, 2, end), ...silence(second, quiet * FRAME_BYTES), data];
        return { id, blob: new Blob(parts, { type: "audio/wav" }) };
      }),
      seconds: end / sampleRate,
    };
  }

  return {
    push,
    startAt,
    finish,
    started: () => frames > 0,
    full: () => frames >= maxFrames,
    seconds: () => frames / sampleRate,
  };
}
