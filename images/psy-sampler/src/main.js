import "./style.css";
import { createAi } from "./ai.js";
import { createEngine } from "./audio/engine.js";
import { createCloud } from "./cloud.js";
import { guardClose } from "./closeGuard.js";
import { createMediaKeys } from "./mediaKeys.js";
import { createSamples } from "./samples.js";
import { detectLang, setLang } from "./i18n/index.js";
import { createStats } from "./stats.js";
import { browserStorage, loadState } from "./storage.js";
import { claimTab } from "./tabs.js";
import { mountApp } from "./ui/app.js";
import { showIntro } from "./ui/intro.js";
import { askToTake } from "./ui/elsewhere.js";
import { showUpdate } from "./ui/updateNotice.js";
import { watchVersion } from "./update.js";
import { createFeed } from "./visuals/feed.js";
import { bandsOf } from "./visuals/listen.js";

// The AudioContext is NOT created here: the engine builds it on the first
// click (autoplay policy).
const samples = createSamples();
const engine = createEngine({ sampleBuffer: samples.get });
// Stop the way the button does, so the transport shows it.
const stopPlaying = () => {
  if (engine.isRunning()) document.querySelector("button.stop")?.click();
};
let leaving = false; // cut off: reloading, and the account is not ours to let go
// Closing the tab while it plays asks first; the page's own reloads don't.
const closing = guardClose({ playing: engine.isRunning });
const reload = () => {
  closing.leave();
  location.reload();
};
// The account plays on one device: with another one on it, this one asks
// before taking it; one that lost it stops and reloads into that question.
const cloud = createCloud({
  storage: browserStorage(),
  playing: engine.isRunning,
  ask: ({ playing }) => {
    stopPlaying();
    return askToTake({ where: "device", playing });
  },
  onDropped: () => {
    leaving = true;
    stopPlaying();
    stats.report();
    reload();
  },
});
// Seconds played and a few counts for psy-sync's usage numbers (stats.js).
const stats = createStats({ engine, storage: browserStorage() });
stats.start();
// The keyboard's play/pause and stop keys drive the transport.
const mediaKeys = createMediaKeys();
// The ✨ AI's models: Chrome's built-in one where it runs, or an LM Studio
// endpoint. Created here so a remount keeps the session.
const ai = createAi();
// The visuals in another window (visuals.html) follow the engine from here.
createFeed(engine, { bandsOf });
// The app mounts once this tab holds the sampler: with another tab already on
// it, only after you choose to cut that one off. A tab cut off that way stops,
// saves and reloads into the same question.
setLang(detectLang(loadState(browserStorage()).lang, navigator.languages ?? []));
claimTab({
  playing: engine.isRunning,
  ask: ({ playing }) => askToTake({ where: "tab", playing }),
  onDropped: () => {
    leaving = true;
    engine.stop();
    stats.report();
    cloud.flush().finally(reload);
  },
}).then(() => {
  mountApp(document.getElementById("app"), engine, { cloud, samples, stats, mediaKeys, ai });
  // First visit only: what this is, and the way to the how-to page.
  showIntro({
    storage: browserStorage(),
    openHelp: () => document.querySelector('[data-action="help"]')?.click(),
  });
});
// A save still waiting for its debounce goes up before the tab disappears,
// and so does the usage since the last report.
// Back in view, a beat tells at once whether another device took the account.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return void cloud.beat();
  cloud.flush();
  stats.report();
});
// Closing the tab frees the account for the next device; a page kept for
// back/forward still holds it and beats again if it comes back.
addEventListener("pagehide", (e) => {
  if (!e.persisted && !leaving) cloud.release();
});
// A deploy while you play: offer the new version without cutting the loop.
watchVersion({
  current: import.meta.env.BUILD_ID,
  onNew: () =>
    showUpdate({
      reload: () => cloud.flush().finally(reload),
    }),
});
