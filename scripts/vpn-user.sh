#!/usr/bin/env bash
# Manage who can sign in to the wg-easy admin (vpn.agu.com.ar) with Google.
#
# wg-easy only lets in a Google account whose email already belongs to one of
# its users (OAUTH_AUTO_REGISTER=false), and has no screen to create users. This
# writes them straight into its SQLite database, so the emails never land in git.
#
#   scripts/vpn-user.sh list
#   scripts/vpn-user.sh add <email> [display name]
#   scripts/vpn-user.sh remove <email>
#
# Needs kubectl access to the cluster (KUBECONFIG). See docs/vpn.md.
set -euo pipefail

NAMESPACE="${WG_EASY_NAMESPACE:-wg-easy}"

usage() {
  sed -n '8,10p' "$0" | sed 's/^# *//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
command="$1"
# Google hands wg-easy the address in lowercase, and it matches it exactly.
email="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
name="${3:-${email%%@*}}"
case "$command" in
  list) ;;
  add | remove) [ -n "$email" ] || usage ;;
  *) usage ;;
esac

# Runs inside the wg-easy container, with the libsql driver its server uses.
# Users added here are admins (role 1), like every user wg-easy creates itself,
# with no password: password sign-in is off anyway.
read -r -d '' script <<'JS' || true
const Database = require("/app/server/node_modules/libsql");
const db = new Database("/etc/wireguard/wg-easy.db");
const [command, email, name] = process.argv.slice(1);
if (command === "list") {
  for (const u of db.prepare("SELECT username, email, oauth_provider, enabled FROM users_table ORDER BY id").all()) {
    const linked = u.oauth_provider ? `linked to ${u.oauth_provider}` : "not signed in yet";
    console.log(`${u.email ?? "(no email)"}\t${u.username}\t${linked}${u.enabled ? "" : "\tdisabled"}`);
  }
} else if (command === "add") {
  if (db.prepare("SELECT 1 FROM users_table WHERE email = ? OR username = ?").get(email, email)) {
    console.error(`${email} is already a user`);
    process.exit(1);
  }
  db.prepare(
    "INSERT INTO users_table (username, password, email, name, role, totp_verified, enabled) VALUES (?, NULL, ?, ?, 1, 0, 1)"
  ).run(email, email, name);
  console.log(`added ${email}: they can now sign in with Google`);
} else if (command === "remove") {
  const { changes } = db.prepare("DELETE FROM users_table WHERE email = ?").run(email);
  if (!changes) {
    console.error(`${email} is not a user`);
    process.exit(1);
  }
  console.log(`removed ${email}`);
}
JS

exec kubectl -n "$NAMESPACE" exec deploy/wg-easy -c wg-easy -- node -e "$script" "$command" "$email" "$name"
