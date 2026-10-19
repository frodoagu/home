// renderFx (takeFx.js) off the page's thread: a busy chain takes a second or
// more, which would stall the scheduler while the music plays.
import { renderFx } from "./takeFx.js";

onmessage = ({ data: { take, fx } }) => {
  const out = renderFx(take, fx);
  postMessage(out, out.channels.map((c) => c.buffer));
};
