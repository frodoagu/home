// The cloud-save corner of the top bar. Always visible, so the state is never
// a guess: checking, cloud unavailable, signed out ("this browser only" + the
// Google button), or the account with its sync state and a menu (sign out,
// delete my data). Talks to cloud.js; the app hands it the workspace
// (snapshot), a way to replace it (apply) and whether it is still factory
// (pristine).
import { el } from "./dom.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gis = null; // the script loads once per page
let onCredential = () => {}; // GIS keeps the first callback: route through this

function loadGis(clientId) {
  gis ??= new Promise((resolve, reject) => {
    const script = el("script", { src: GIS_SRC, async: "" });
    script.onload = () => {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (res) => onCredential(res.credential),
        ux_mode: "popup",
        auto_select: false,
      });
      resolve(window.google.accounts.id);
    };
    script.onerror = () => {
      gis = null;
      reject(new Error("gsi"));
    };
    document.head.append(script);
  });
  return gis;
}

let checked = false; // reconcile once per page load, not on every remount
let retry = null; // the API was down: ask again later, once per page
const RETRY_MS = 30_000;

export function mountAccount({ cloud, tx, lang, snapshot, pristine, apply, confirm, status, loadButton = loadGis }) {
  const node = el("div", { class: "account" });
  const pill = el("span", { class: "sync-pill", role: "status" });

  async function reconcile() {
    const local = snapshot();
    try {
      const { action, remote } = await cloud.check(local, pristine());
      if (action === "pull") {
        cloud.adopt(remote, remote.state);
        apply(remote.state);
      } else if (action === "adopt" || action === "none") cloud.adopt(remote, local);
      else if (action === "push") await cloud.push(local);
      else await resolveConflict(remote);
    } catch {
      // Offline or the API hiccuped: the next local save tries again.
    }
  }

  async function resolveConflict(remote) {
    if (confirm(tx.cloud.conflict)) {
      cloud.adopt(remote, remote.state);
      apply(remote.state);
    } else await cloud.push(snapshot(), { force: true });
  }

  const time = (ms) => new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

  // The pill: one word on where the setup lives right now.
  function paintPill() {
    const { checking, available, user, phase, savedAt } = cloud.info;
    let state;
    let text;
    let title = "";
    if (checking) [state, text] = ["checking", tx.cloud.checking];
    else if (!available) [state, text, title] = ["off", tx.cloud.unavailable, tx.cloud.unavailableTitle];
    else if (!user) [state, text, title] = ["local", tx.cloud.localOnly, tx.cloud.pitch];
    else {
      state = phase;
      text = phase === "saved" && savedAt ? tx.cloud.savedAt(time(savedAt)) : tx.cloud.phases[phase];
      title = tx.cloud.signedInAs(user.email);
    }
    pill.dataset.state = state;
    pill.textContent = `☁ ${text}`;
    pill.title = title;
  }

  function accountMenu(user) {
    const out = el("button", { type: "button", class: "menu-item", "data-action": "sign-out", text: tx.cloud.signOut });
    out.addEventListener("click", () => cloud.signOut());
    const del = el("button", {
      type: "button",
      class: "menu-item danger",
      "data-action": "delete-account",
      text: tx.cloud.deleteAccount,
    });
    del.addEventListener("click", async () => {
      if (!confirm(tx.cloud.confirmDelete)) return;
      await cloud.deleteAccount().then(
        () => status(tx.cloud.deleted),
        () => status(tx.cloud.phases.error),
      );
    });
    const initial = (user.name || user.email).trim()[0]?.toUpperCase() ?? "?";
    const menu = el(
      "details",
      { class: "account-menu" },
      el(
        "summary",
        { "aria-label": tx.cloud.account },
        el("span", { class: "avatar", "aria-hidden": "true", text: initial }),
        el("span", { class: "account-email", text: user.email }),
      ),
      el("div", { class: "menu" }, el("p", { class: "menu-note", text: tx.cloud.signedInAs(user.email) }), out, del),
    );
    // Close on an outside click, like any menu.
    const close = (e) => {
      if (!menu.contains(e.target)) menu.open = false;
    };
    document.addEventListener("click", close);
    cleanups.push(() => document.removeEventListener("click", close));
    return menu;
  }

  const cleanups = [];
  function render() {
    cleanups.splice(0).forEach((fn) => fn());
    paintPill();
    const { available, user } = cloud.info;
    if (!available) {
      node.replaceChildren(pill);
      return;
    }
    if (user) {
      node.replaceChildren(pill, accountMenu(user));
      return;
    }
    const slot = el("div", { class: "gsi-slot" });
    node.replaceChildren(pill, slot);
    loadButton(cloud.info.clientId, (credential) => onCredential(credential)).then(
      (id) => {
        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
        id.renderButton(slot, {
          theme: dark ? "filled_black" : "outline",
          size: "medium",
          shape: "pill",
          text: "signin",
          locale: lang,
        });
      },
      () => {
        slot.replaceWith(el("span", { class: "login-off", text: tx.cloud.loginUnavailable }));
      },
    );
  }

  onCredential = async (credential) => {
    try {
      await cloud.signIn(credential);
      await reconcile();
    } catch {
      status(tx.cloud.signInFailed);
    }
  };

  const off = cloud.on((event, data) => {
    if (event === "phase") paintPill();
    else if (event === "user") render();
    else if (event === "conflict") resolveConflict(data);
    else if (event === "info") {
      render();
      if (cloud.info.user && !checked) {
        checked = true;
        reconcile();
      }
      if (!cloud.info.available) retry ??= setTimeout(() => cloud.init().finally(() => (retry = null)), RETRY_MS);
    }
  });

  render();
  if (cloud.info.checking) cloud.init();

  return {
    node,
    destroy: () => {
      off();
      cleanups.forEach((fn) => fn());
    },
  };
}

// Tests start every page fresh.
export const resetAccountForTests = () => {
  checked = false;
  gis = null;
  clearTimeout(retry);
  retry = null;
};
