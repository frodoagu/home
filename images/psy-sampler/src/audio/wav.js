// WAV export: 24-bit PCM, interleaved. Pure, so it is tested without audio.

const BYTES = 3;

/** { sampleRate, channels: [Float32Array, ...] } -> ArrayBuffer of a .wav file. */
export function encodeWav({ sampleRate, channels }) {
  const frames = channels[0]?.length ?? 0;
  const out = new Uint8Array(44 + frames * channels.length * BYTES);
  out.set(new Uint8Array(wavHeader(sampleRate, channels.length, frames)));
  out.set(pcm24(channels, 0, frames), 44);
  return out.buffer;
}

// The 44-byte header of a PCM .wav holding `frames` frames.
export function wavHeader(sampleRate, channelCount, frames) {
  const block = channelCount * BYTES;
  const dataSize = frames * block;
  const view = new DataView(new ArrayBuffer(44));
  const ascii = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, BYTES * 8, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return view.buffer;
}

// Frames [from, to) of the channels as interleaved 24-bit PCM, clipped to full scale.
export function pcm24(channels, from, to) {
  const out = new Uint8Array((to - from) * channels.length * BYTES);
  let at = 0;
  for (let i = from; i < to; i++) {
    for (const data of channels) {
      const v = Math.round(Math.max(-1, Math.min(1, data[i])) * 0x7fffff);
      out[at] = v & 0xff;
      out[at + 1] = (v >> 8) & 0xff;
      out[at + 2] = (v >> 16) & 0xff;
      at += BYTES;
    }
  }
  return out;
}

export const SILENCE = 1e-4; // -80 dBFS
export const PAD_SECONDS = 0.05;

// Cuts the silence after the last audible sample, keeping a short pad.
export function trimTail(channels, sampleRate) {
  let last = 0;
  for (const data of channels) {
    for (let i = data.length - 1; i > last; i--) {
      if (Math.abs(data[i]) > SILENCE) {
        last = i;
        break;
      }
    }
  }
  const end = Math.min(channels[0].length, last + 1 + Math.round(PAD_SECONDS * sampleRate));
  return channels.map((d) => d.slice(0, end));
}
