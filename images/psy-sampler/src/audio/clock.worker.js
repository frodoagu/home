// The scheduler's metronome: posts every `ms` it is sent, 0 stops it. A
// worker's timers keep their pace in a background tab, where the page's own
// are held to one tick a second or less.
let timer = null;

onmessage = ({ data: ms }) => {
  clearInterval(timer);
  timer = ms > 0 ? setInterval(() => postMessage(null), ms) : null;
};
