// Vitest setup: extends `expect` with jest-dom matchers (toBeInTheDocument, …)
// and provides minimal browser shims jsdom doesn't implement.
import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver — the Mandelbrot canvas observes its container.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
