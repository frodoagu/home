// The keyboard's media keys (play/pause, stop) through the Media Session API.
// Browsers route those keys only to a page holding a media session, and Web
// Audio alone does not open one, so a silent looping <audio> plays while the
// engine runs and pauses with it. It must be longer than 5 s: Chrome leaves
// shorter media out of the session. The handlers outlive remounts; each mount
// binds its own transport.
import { encodeWav } from "./audio/wav.js";

const SILENCE_SECONDS = 6;
const SILENCE_RATE = 8000;

function silentAudio() {
  const wav = encodeWav({ sampleRate: SILENCE_RATE, channels: [new Float32Array(SILENCE_SECONDS * SILENCE_RATE)] });
  const audio = new Audio(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
  audio.loop = true;
  return audio;
}

export function createMediaKeys({
  session = globalThis.navigator?.mediaSession,
  makeAudio = silentAudio,
  title = globalThis.document?.title,
} = {}) {
  let transport = null; // { playing, play, stop }: the mounted app's buttons
  let audio = null;

  const play = () => {
    if (transport && !transport.playing()) transport.play();
  };
  const stop = () => {
    if (transport?.playing()) transport.stop();
  };

  if (session) {
    session.setActionHandler("play", play);
    session.setActionHandler("pause", stop);
    session.setActionHandler("stop", stop);
  } else {
    // Without a media session the keys reach the page as plain key events.
    globalThis.addEventListener?.("keydown", (e) => {
      if (e.key === "MediaPlayPause") transport?.playing() ? stop() : play();
      else if (e.key === "MediaPlay") play();
      else if (e.key === "MediaPause" || e.key === "MediaStop") stop();
    });
  }

  return {
    /** The mounted app's transport, or null while none is. */
    bind(next) {
      transport = next;
    },
    /** Whether the engine runs: the silent track and the session follow it. */
    setPlaying(playing) {
      if (!session) return;
      if (playing && !audio) {
        audio = makeAudio();
        if (globalThis.MediaMetadata) session.metadata = new MediaMetadata({ title });
      }
      if (!audio) return;
      session.playbackState = playing ? "playing" : "paused";
      if (playing && audio.paused) audio.play()?.catch?.(() => {});
      else if (!playing && !audio.paused) audio.pause();
    },
  };
}
