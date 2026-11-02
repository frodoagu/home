#!/usr/bin/env bash
# Manage who can sign in to the wg-easy admin (vpn.agu.com.ar) with Google, and
# who owns each device.
#
# wg-easy only lets in a Google account whose email already belongs to one of
# its users (OAUTH_AUTO_REGISTER=false), and has no screen to create users. This
# writes them straight into its SQLite database, so the emails never land in git.
#
#   scripts/vpn-user.sh list
#   scripts/vpn-user.sh add <email> [display name]
#   scripts/vpn-user.sh give <email> <device name>
#   scripts/vpn-user.sh remove <email>
#
# Needs kubectl access to the cluster (KUBECONFIG). See docs/vpn.md.
set -euo pipefail

NAMESPACE="${WG_EASY_NAMESPACE:-wg-easy}"

usage() {
  sed -n '9,12p' "$0" | sed 's/^# *//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
command="$1"
# Google hands wg-easy the address in lowercase, and it matches it exactly.
email="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
extra="${3:-}"
case "$command" in
  list) ;;
  add | remove) [ -n "$email" ] || usage ;;
  give) [ -n "$email" ] && [ -n "$extra" ] || usage ;;
  *) usage ;;
esac

# Runs inside the wg-easy container, with the libsql driver its server uses.
# Users added here are clients (role 2) with no password: the admin role comes
# from OAUTH_ADMIN_EMAILS (the wg-easy-admins secret), which wg-easy re-applies
# on every Google sign-in.
read -r -d '' script <<'JS' || true
const Database = require("/app/server/node_modules/libsql");
const db = new Database("/etc/wireguard/wg-easy.db");
// wg-easy writes too (sign-ins, its cron): wait for its lock instead of failing.
db.exec("PRAGMA busy_timeout = 10000");
const [command, email, extra] = process.argv.slice(1);
const user = () => db.prepare("SELECT id FROM users_table WHERE email = ?").get(email);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (command === "list") {
  const rows = db.prepare(
    `SELECT u.username, u.email, u.role, u.oauth_provider, u.enabled, COUNT(c.id) AS devices
       FROM users_table u LEFT JOIN clients_table c ON c.user_id = u.id
      GROUP BY u.id ORDER BY u.id`
  ).all();
  for (const u of rows) {
    const role = u.role === 1 ? "admin" : "client";
    const linked = u.oauth_provider ? `linked to ${u.oauth_provider}` : "not signed in yet";
    console.log(`${u.email ?? "(no email)"}\t${u.username}\t${role}\t${u.devices} devices\t${linked}${u.enabled ? "" : "\tdisabled"}`);
  }
} else if (command === "add") {
  if (db.prepare("SELECT 1 FROM users_table WHERE email = ? OR username = ?").get(email, email)) {
    fail(`${email} is already a user`);
  }
  db.prepare(
    "INSERT INTO users_table (username, password, email, name, role, totp_verified, enabled) VALUES (?, NULL, ?, ?, 2, 0, 1)"
  ).run(email, email, extra || email.split("@")[0]);
  console.log(`added ${email}: they can now sign in with Google`);
} else if (command === "give") {
  const owner = user() ?? fail(`${email} is not a user`);
  const { changes } = db.prepare("UPDATE clients_table SET user_id = ? WHERE name = ?").run(owner.id, extra);
  if (!changes) fail(`no device is named "${extra}"`);
  console.log(`"${extra}" now belongs to ${email}`);
} else if (command === "remove") {
  const owner = user() ?? fail(`${email} is not a user`);
  // clients_table.user_id references the user ON DELETE RESTRICT.
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM clients_table WHERE user_id = ?").get(owner.id);
  if (n) fail(`${email} still owns ${n} devices: delete them in the UI or \`give\` them to someone first`);
  db.prepare("DELETE FROM users_table WHERE id = ?").run(owner.id);
  console.log(`removed ${email}`);
}
JS

exec kubectl -n "$NAMESPACE" exec deploy/wg-easy -c wg-easy -- node -e "$script" "$command" "$email" "$extra"
