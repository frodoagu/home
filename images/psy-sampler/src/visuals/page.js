// visuals.html: the show on its own page. Opened from the sampler's ⧉ it
// follows that window over a BroadcastChannel (feed.js), so it can sit on a
// TV or a projector while the sampler stays on the laptop. Opened by itself
// (a phone, a TV's browser) it plays at rest until 🎤 lets it hear the room.
import { detectLang, lang, setLang, t } from "../i18n/index.js";
import { browserStorage, loadState } from "../storage.js";
import { mountShow } from "./show.js";
import { channelSource, idleSource } from "./sources.js";

setLang(detectLang(loadState(browserStorage()).lang, navigator.languages ?? []));
const tx = t().visuals;
document.title = tx.title;
document.documentElement.lang = lang();

mountShow({
  root: document.body,
  source: channelSource() ?? idleSource(),
  tx,
  storage: browserStorage(),
  // Opened by the sampler it can close itself; typed in, closing is the tab's.
  canClose: Boolean(window.opener),
  onClose: () => window.close(),
});
