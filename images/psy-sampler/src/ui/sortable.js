// Drag to reorder the direct children of a container, in place. Two ways in:
//   handle  a grip inside the item starts the drag at once (layer rows)
//   none    the item itself drags once the pointer travels THRESHOLD px
//           (mouse, pen) or after a LONG_PRESS (touch, so a swipe still
//           scrolls the page and a tap still clicks)
// Keyboard: arrows on the grip (or Alt+arrows on the item) move it one slot.
// onDrop(keys) gets the new order of the items' data-<key> values.

const THRESHOLD = 6;
const LONG_PRESS = 350;

export function sortable(container, { item, handle = null, key, onDrop }) {
  let pending = null; // { el, x, y, id, timer }
  let dragging = null;
  let moved = false;

  const items = () => [...container.children].filter((c) => c.matches(item));
  const keys = () => items().map((c) => c.dataset[key]);

  function begin(el) {
    dragging = el;
    moved = false;
    el.classList.add("is-dragging");
    container.classList.add("is-sorting");
    navigator.vibrate?.(15);
  }

  function finish() {
    clearTimeout(pending?.timer);
    pending = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("touchmove", blockScroll);
    if (!dragging) return;
    dragging.classList.remove("is-dragging");
    container.classList.remove("is-sorting");
    dragging = null;
    if (moved) {
      // The release would also click whatever is under it.
      const swallow = (e) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      onDrop(keys());
    }
  }

  // The slot under the pointer: before or after the item it is over. Items
  // that share a row (a grid of tiles) split left/right, a column top/bottom.
  function place(x, y) {
    for (const other of items()) {
      if (other === dragging) continue;
      const r = other.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const row = items().some((o) => o !== other && Math.abs(o.getBoundingClientRect().top - r.top) < 2);
      const after = row ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
      const ref = after ? other.nextElementSibling : other;
      if (ref !== dragging && dragging.nextElementSibling !== ref) {
        container.insertBefore(dragging, ref);
        moved = true;
      }
      return;
    }
  }

  function onMove(e) {
    if (dragging) {
      e.preventDefault();
      place(e.clientX, e.clientY);
      return;
    }
    if (!pending || e.pointerId !== pending.id) return;
    const far = Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > THRESHOLD;
    if (!far) return;
    if (e.pointerType === "touch") finish(); // moved before the long press: a scroll
    else begin(pending.el);
  }

  const onUp = () => finish();
  const blockScroll = (e) => {
    if (dragging) e.preventDefault();
  };

  function onDown(e) {
    if (e.button !== 0 || dragging) return;
    const el = e.target.closest(item);
    if (!el || el.parentElement !== container) return;
    if (handle && !e.target.closest(handle)) return;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("touchmove", blockScroll, { passive: false });
    if (handle) {
      e.preventDefault();
      begin(el);
      return;
    }
    pending = { el, x: e.clientX, y: e.clientY, id: e.pointerId, timer: 0 };
    if (e.pointerType === "touch") pending.timer = setTimeout(() => pending && begin(pending.el), LONG_PRESS);
  }

  function onKey(e) {
    const el = e.target.closest(item);
    if (!el || el.parentElement !== container) return;
    if (handle ? !e.target.closest(handle) : !e.altKey) return;
    const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const list = items();
    const to = list.indexOf(el) + delta;
    if (to < 0 || to >= list.length) return;
    container.insertBefore(el, delta > 0 ? list[to].nextElementSibling : list[to]);
    e.target.focus();
    onDrop(keys());
  }

  // A long press on touch would open the context menu instead.
  const onContext = (e) => {
    if (pending || dragging) e.preventDefault();
  };

  container.addEventListener("pointerdown", onDown);
  container.addEventListener("keydown", onKey);
  container.addEventListener("contextmenu", onContext);
  return {
    destroy() {
      finish();
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("keydown", onKey);
      container.removeEventListener("contextmenu", onContext);
    },
  };
}
