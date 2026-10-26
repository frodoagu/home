import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { wheelValue, installWheelRanges, NOTCH_PX, SCROLL_GRACE_MS } from "./wheelRange";

describe("wheelValue", () => {
  it("moves a 25th of the span per notch, on the step grid", () => {
    expect(wheelValue({ value: 0.5, min: 0, max: 1, step: 0.01 }, 1)).toBe(0.54);
    expect(wheelValue({ value: 10, min: 1, max: 100, step: 1 }, 1)).toBe(14);
    expect(wheelValue({ value: 10, min: 1, max: 100, step: 1 }, -2)).toBe(2);
  });

  it("moves a single step with Shift", () => {
    expect(wheelValue({ value: 0.5, min: 0, max: 1, step: 0.01 }, 1, true)).toBe(0.51);
    expect(wheelValue({ value: 1, min: 0, max: 10, step: 0.1 }, -3, true)).toBe(0.7);
  });

  it("never moves less than a step on a coarse slider", () => {
    expect(wheelValue({ value: 2, min: 0, max: 10, step: 1 }, 1)).toBe(3);
  });

  it("stays within min and max", () => {
    expect(wheelValue({ value: 0.98, min: 0, max: 1, step: 0.01 }, 3)).toBe(1);
    expect(wheelValue({ value: 21, min: 20, max: 100, step: 1 }, -5)).toBe(20);
  });

  it("snaps to steps counted from min", () => {
    expect(wheelValue({ value: 3, min: 1, max: 9, step: 2 }, 1, true)).toBe(5);
  });
});

describe("installWheelRanges", () => {
  let time;
  let uninstall;
  let slider;
  let other;
  let onInput;

  const wheel = (el, deltaY, extra = {}) => {
    const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true, ...extra });
    el.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    time = 0;
    document.body.innerHTML = `
      <p id="other">text</p>
      <input id="s" type="range" min="0" max="1" step="0.01" value="0.5" />
      <input id="d" type="range" min="0" max="1" step="0.01" value="0.5" disabled />`;
    slider = document.getElementById("s");
    other = document.getElementById("other");
    onInput = vi.fn();
    slider.addEventListener("input", onInput);
    uninstall = installWheelRanges(document, () => time);
  });

  afterEach(() => uninstall());

  it("wheel up raises the slider and fires input", () => {
    const e = wheel(slider, -NOTCH_PX);
    expect(slider.value).toBe("0.54");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("wheel down lowers it", () => {
    wheel(slider, NOTCH_PX);
    expect(slider.value).toBe("0.46");
  });

  it("adds small trackpad deltas up to a notch", () => {
    for (let i = 0; i < 4; i++) wheel(slider, -NOTCH_PX / 5);
    expect(slider.value).toBe("0.5");
    wheel(slider, -NOTCH_PX / 5);
    expect(slider.value).toBe("0.54");
  });

  it("counts line-mode deltas as pixels", () => {
    wheel(slider, -3, { deltaMode: 1 });
    expect(slider.value).toBe("0.5");
    wheel(slider, -1, { deltaMode: 1 });
    expect(slider.value).toBe("0.54");
  });

  it("leaves disabled sliders and the rest of the page alone", () => {
    expect(wheel(document.getElementById("d"), -NOTCH_PX).defaultPrevented).toBe(false);
    expect(document.getElementById("d").value).toBe("0.5");
    expect(wheel(other, -NOTCH_PX).defaultPrevented).toBe(false);
  });

  it("lets a page scroll pass over a slider", () => {
    wheel(other, NOTCH_PX);
    time += 100;
    expect(wheel(slider, NOTCH_PX).defaultPrevented).toBe(false);
    expect(slider.value).toBe("0.5");
    time += SCROLL_GRACE_MS + 1;
    wheel(slider, NOTCH_PX);
    expect(slider.value).toBe("0.46");
  });
});
