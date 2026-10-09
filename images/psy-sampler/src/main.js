import "./style.css";
import { createEngine } from "./audio/engine.js";
import { mountApp } from "./ui/app.js";

// The AudioContext is NOT created here: the engine builds it on the first
// click (autoplay policy).
mountApp(document.getElementById("app"), createEngine());
