// The editor's foldable boxes (ui/editor.js): which ones are open, and
// whether a folded one still changes the sound, so its summary can say so.
// The header, the source, the voice's sliders and the grid never fold.
import { HP_OPEN, LP_OPEN } from "./audio/insert.js";

export const FOLDS = ["insert", "modulation", "space", "pattern"];

// Folded until opened. Anything but a true (a missing key, a stored
// value from another version) reads as folded.
export const cleanFolds = (saved) => Object.fromEntries(FOLDS.map((k) => [k, saved?.[k] === true]));

// Off its NEUTRAL value, not off the factory's: a factory sound that ships
// with a filter still has one on, and that is what a folded box hides.
export function foldActive(key, data) {
  const ins = data.insert;
  switch (key) {
    case "insert":
      return ins.filter !== "off" || ins.drive !== "off" || ins.hp > HP_OPEN || ins.lp < LP_OPEN;
    case "modulation":
      return ins.phaser > 0 || ins.trem > 0;
    case "space":
      return ins.pan !== 0 || ins.width > 0 || Boolean(data.swing || data.nudge || data.duck);
    case "pattern":
      return (data.speed ?? 1) !== 1 || (data.iter ?? 1) !== 1 || Boolean(data.echo);
    default:
      return false;
  }
}
