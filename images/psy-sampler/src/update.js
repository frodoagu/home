// New-version check: each build's id (vite.config.js) is baked into the page
// and written to /version.json. The page polls that file, every minute and
// whenever the tab comes back, and tells onNew once per build it hasn't seen.
export const CHECK_MS = 60_000;

export function watchVersion({
  current,
  onNew,
  fetch = globalThis.fetch,
  url = "/version.json",
  every = CHECK_MS,
  doc = globalThis.document,
}) {
  if (!current || current === "dev") return () => {};
  let seen = current;
  const check = async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const { build } = await res.json();
      if (typeof build !== "string" || !build || build === seen) return;
      seen = build;
      onNew(build);
    } catch {
      // Offline, or a deploy halfway: the next check tries again.
    }
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") check();
  };
  const timer = setInterval(check, every);
  doc?.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", onVisible);
  };
}
