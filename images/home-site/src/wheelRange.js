/* -------------------------------------------------------------------------
 * The mouse wheel nudges whatever range input is under the pointer, in every
 * app. React only sees an ordinary `input` event, so controlled sliders need
 * no changes.
 *
 * A notch is a mouse's 100 px (trackpads add up to it) and moves the slider a
 * 25th of its span, or a single step with Shift held. A wheel gesture that is
 * already scrolling the page keeps scrolling when a slider passes under the
 * pointer.
 * ---------------------------------------------------------------------- */

export const NOTCH_PX = 100;
export const LINE_PX = 33;
export const NOTCHES_PER_SPAN = 25;
export const SCROLL_GRACE_MS = 400;

const decimals = (n) => (String(n).split(".")[1] ?? "").length;

export function wheelValue({ value, min, max, step }, notches, fine = false) {
  const span = max - min;
  const unit = step > 0 ? step : span / 100;
  const per = fine ? unit : Math.max(unit, Math.round(span / NOTCHES_PER_SPAN / unit) * unit);
  const raw = Math.min(max, Math.max(min, value + notches * per));
  const snapped = min + Math.round((raw - min) / unit) * unit;
  return Number(Math.min(max, snapped).toFixed(Math.max(decimals(unit), decimals(min))));
}

const pixels = (e) => {
  const d = e.deltaY || e.deltaX;
  return e.deltaMode === 1 ? d * LINE_PX : e.deltaMode === 2 ? d * NOTCH_PX : d;
};

export function installWheelRanges(target = document, now = () => performance.now()) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  let input = null;
  let sum = 0;
  let scrolledAt = -Infinity;

  const onWheel = (e) => {
    const el = e.target instanceof Element ? e.target.closest('input[type="range"]') : null;
    if (!el || el.disabled || now() - scrolledAt < SCROLL_GRACE_MS) {
      scrolledAt = now();
      return;
    }
    e.preventDefault();
    if (el !== input) {
      input = el;
      sum = 0;
    }
    sum -= pixels(e);
    const notches = Math.trunc(sum / NOTCH_PX);
    if (!notches) return;
    sum -= notches * NOTCH_PX;
    const num = (name, fallback) => (el.getAttribute(name) === null ? fallback : Number(el.getAttribute(name)));
    const next = wheelValue(
      { value: Number(el.value), min: num("min", 0), max: num("max", 100), step: num("step", 1) },
      notches,
      e.shiftKey,
    );
    if (String(next) === el.value) return;
    setValue.call(el, String(next));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  target.addEventListener("wheel", onWheel, { passive: false });
  return () => target.removeEventListener("wheel", onWheel);
}
