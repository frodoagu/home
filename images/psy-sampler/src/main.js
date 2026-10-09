import "./style.css";
import { createEngine } from "./audio/engine.js";
import { createCloud } from "./cloud.js";
import { browserStorage } from "./storage.js";
import { mountApp } from "./ui/app.js";

// The AudioContext is NOT created here: the engine builds it on the first
// click (autoplay policy).
const cloud = createCloud({ storage: browserStorage() });
mountApp(document.getElementById("app"), createEngine(), { cloud });
// A save still waiting for its debounce goes up before the tab disappears.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") cloud.flush();
});
