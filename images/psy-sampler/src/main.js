import "./style.css";
import { createEngine } from "./audio/engine.js";
import { createCloud } from "./cloud.js";
import { createSamples } from "./samples.js";
import { browserStorage } from "./storage.js";
import { mountApp } from "./ui/app.js";
import { showUpdate } from "./ui/updateNotice.js";
import { watchVersion } from "./update.js";

// The AudioContext is NOT created here: the engine builds it on the first
// click (autoplay policy).
const cloud = createCloud({ storage: browserStorage() });
const samples = createSamples();
mountApp(document.getElementById("app"), createEngine({ sampleBuffer: samples.get }), { cloud, samples });
// A save still waiting for its debounce goes up before the tab disappears.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") cloud.flush();
});
// A deploy while you play: offer the new version without cutting the loop.
watchVersion({
  current: import.meta.env.BUILD_ID,
  onNew: () =>
    showUpdate({
      reload: () => cloud.flush().finally(() => location.reload()),
    }),
});
