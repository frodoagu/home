import "./style.css";
import { createEngine } from "./audio/engine.js";
import { createCloud } from "./cloud.js";
import { createSamples } from "./samples.js";
import { createStats } from "./stats.js";
import { browserStorage } from "./storage.js";
import { mountApp } from "./ui/app.js";
import { showIntro } from "./ui/intro.js";
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
mountApp(document.getElementById("app"), engine, { cloud, samples, stats });
// First visit only: what this is, and the way to the how-to page.
showIntro({
  storage: browserStorage(),
  openHelp: () => document.querySelector('[data-action="help"]')?.click(),
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
