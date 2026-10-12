import "./style.css";
import { createAi } from "./ai.js";
import { createEngine } from "./audio/engine.js";
import { createCloud } from "./cloud.js";
import { createMediaKeys } from "./mediaKeys.js";
import { createSamples } from "./samples.js";
import { detectLang, setLang } from "./i18n/index.js";
import { createStats } from "./stats.js";
import { browserStorage, loadState } from "./storage.js";
import { claimTab } from "./tabs.js";
import { mountApp } from "./ui/app.js";
import { showIntro } from "./ui/intro.js";
import { askForTab } from "./ui/tabNotice.js";
import { showUpdate } from "./ui/updateNotice.js";
import { watchVersion } from "./update.js";

// The AudioContext is NOT created here: the engine builds it on the first
// click (autoplay policy).
const cloud = createCloud({ storage: browserStorage() });
const samples = createSamples();
const engine = createEngine({ sampleBuffer: samples.get });
// Seconds played and a few counts for psy-sync's usage numbers (stats.js).
const stats = createStats({ engine, storage: browserStorage() });
stats.start();
// The keyboard's play/pause and stop keys drive the transport.
const mediaKeys = createMediaKeys();
// The ✨ AI's models: Chrome's built-in one where it runs, or an LM Studio
// endpoint. Created here so a remount keeps the session.
const ai = createAi();
// The app mounts once this tab holds the sampler: with another tab already on
// it, only after you choose to cut that one off. A tab cut off that way stops,
// saves and reloads into the same question.
setLang(detectLang(loadState(browserStorage()).lang, navigator.languages ?? []));
claimTab({
  playing: engine.isRunning,
  ask: askForTab,
  onDropped: () => {
    engine.stop();
    stats.report();
    cloud.flush().finally(() => location.reload());
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  cloud.flush();
  stats.report();
});
// A deploy while you play: offer the new version without cutting the loop.
watchVersion({
  current: import.meta.env.BUILD_ID,
  onNew: () =>
    showUpdate({
      reload: () => cloud.flush().finally(() => location.reload()),
    }),
});
