// Closing or reloading the tab while it plays asks first, so a stray Ctrl+W
// doesn't cut the music. The browser words the question ("Leave site?"); the
// page only decides whether to ask. A reload the page makes itself (a new
// version, another tab or device took over) calls `leave()` first and goes
// without asking.
export function guardClose({ target = globalThis, playing }) {
  let leaving = false;
  target.addEventListener("beforeunload", (e) => {
    if (leaving || !playing()) return;
    e.preventDefault();
    e.returnValue = ""; // older Chrome and Safari ask only when it is set
  });
  return {
    leave: () => {
      leaving = true;
    },
  };
}
