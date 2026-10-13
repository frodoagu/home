import { beforeEach, describe, expect, it } from "vitest";
import { guardClose } from "./closeGuard.js";

function unload(target) {
  const e = new Event("beforeunload", { cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("guardClose", () => {
  let target;
  let running;

  beforeEach(() => {
    target = new EventTarget();
    running = false;
  });

  it("asks before closing while it plays", () => {
    running = true;
    guardClose({ target, playing: () => running });
    expect(unload(target).defaultPrevented).toBe(true);
  });

  it("lets a stopped tab go", () => {
    guardClose({ target, playing: () => running });
    expect(unload(target).defaultPrevented).toBe(false);
  });

  it("reads the transport at close time", () => {
    guardClose({ target, playing: () => running });
    running = true;
    expect(unload(target).defaultPrevented).toBe(true);
    running = false;
    expect(unload(target).defaultPrevented).toBe(false);
  });

  it("lets a reload the page makes go while it plays", () => {
    running = true;
    const guard = guardClose({ target, playing: () => running });
    guard.leave();
    expect(unload(target).defaultPrevented).toBe(false);
  });
});
