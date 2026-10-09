// The cloud-save row in the tools panel: a "Sign in with Google" button when
// signed out; the account, the sync state, Sign out and Delete my data when
// signed in. Talks to cloud.js; the app hands it the workspace (snapshot),
// a way to replace it (apply) and whether it is still factory (pristine).
// Hidden while the API is not reachable.
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

export function mountAccount({ cloud, tx, lang, snapshot, pristine, apply, confirm, status, loadButton = loadGis }) {
  const node = el("div", { class: "tools-row account", hidden: "" });
  const phase = el("span", { class: "account-phase", role: "status" });

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

  function render() {
    const { available, user } = cloud.info;
    node.hidden = !available;
    if (!available) return;
    if (user) {
      const out = el("button", { type: "button", class: "ghost", "data-action": "sign-out", text: tx.cloud.signOut });
      out.addEventListener("click", () => cloud.signOut());
      const del = el("button", {
        type: "button",
        class: "ghost danger",
        "data-action": "delete-account",
        text: tx.cloud.deleteAccount,
      });
      del.addEventListener("click", async () => {
        if (!confirm(tx.cloud.confirmDelete)) return;
        await cloud.deleteAccount().then(() => status(tx.cloud.deleted), () => status(tx.cloud.phases.error));
      });
      phase.textContent = tx.cloud.phases[cloud.info.phase] ?? "";
      node.replaceChildren(el("span", { class: "account-email", text: tx.cloud.signedIn(user.email) }), phase, out, del);
      return;
    }
    const slot = el("div", { class: "gsi-slot" });
    node.replaceChildren(el("span", { class: "account-pitch", text: tx.cloud.pitch }), slot);
    node.title = tx.cloud.privacy;
    loadButton(cloud.info.clientId, (credential) => onCredential(credential)).then(
      (id) => {
        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
        id.renderButton(slot, { theme: dark ? "filled_black" : "outline", size: "medium", shape: "pill", locale: lang });
      },
      () => {
        node.hidden = true; // blocked by an extension or offline: no cloud this time
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
    if (event === "phase") phase.textContent = tx.cloud.phases[data] ?? "";
    else if (event === "user") render();
    else if (event === "conflict") resolveConflict(data);
  });

  if (cloud.info.available) render();
  else {
    cloud.init().then(async () => {
      render();
      if (cloud.info.user && !checked) {
        checked = true;
        await reconcile();
      }
    });
  }

  return { node, destroy: off };
}

// Tests start every page fresh.
export const resetAccountForTests = () => {
  checked = false;
  gis = null;
};
