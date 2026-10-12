// One sampler per browser. Two tabs would play over each other and save
// over each other's workspace, so the tab in use holds a Web Lock. A new tab
// finds it held, asks the holder over a BroadcastChannel whether it is
// playing (for the wording), and mounts only once you take over: it steals
// the lock, and the holder learns it lost it (AbortError) and drops out.
const NAME = "psy-sampler:tab";

// How long a new tab waits for the holder to say whether it plays.
export const WAIT_MS = 300;

/**
 * Resolves once this tab holds the sampler. `ask({ playing })` resolves when
 * you choose to take it from the other tab; `onDropped()` runs here when
 * another tab takes it. Without Web Locks it resolves at once.
 */
export function claimTab({
  locks = globalThis.navigator?.locks,
  Channel = globalThis.BroadcastChannel,
  playing,
  ask,
  onDropped,
  wait = WAIT_MS,
}) {
  if (!locks) return Promise.resolve();
  const channel = Channel ? new Channel(NAME) : null;

  const hold = (options) =>
    new Promise((resolve) => {
      let granted = false;
      locks
        .request(NAME, options, (lock) => {
          granted = true;
          resolve(Boolean(lock));
          if (!lock) return undefined;
          if (channel) {
            channel.onmessage = (e) => {
              if (e.data === "ask") channel.postMessage({ playing: Boolean(playing()) });
            };
          }
          return new Promise(() => {}); // held until the tab goes or another one takes it
        })
        .catch((err) => {
          // Locks that refuse outright (an opaque origin) guard nothing.
          if (!granted) return resolve(true);
          if (err?.name !== "AbortError") return;
          if (channel) channel.onmessage = null;
          onDropped();
        });
    });

  const holderPlaying = () =>
    new Promise((resolve) => {
      if (!channel) return resolve(false);
      const done = (value) => {
        clearTimeout(timer);
        channel.onmessage = null;
        resolve(value);
      };
      const timer = setTimeout(() => done(false), wait);
      channel.onmessage = (e) => {
        if (typeof e.data?.playing === "boolean") done(e.data.playing);
      };
      channel.postMessage("ask");
    });

  return hold({ ifAvailable: true }).then(async (mine) => {
    if (mine) return;
    await ask({ playing: await holderPlaying() });
    await hold({ steal: true });
  });
}
