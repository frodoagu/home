// SQLite on the PVC: one row per user, one JSON workspace per user, and one
// row per browser that checked its session (a random id the page keeps; no
// sub = never signed in there). WAL keeps writes small and lets a rolling pod
// read while the old one finishes.
import { Database } from "bun:sqlite";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function openDb(path) {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      sub        TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      seen_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS states (
      sub        TEXT PRIMARY KEY REFERENCES users(sub) ON DELETE CASCADE,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visitors (
      id         TEXT PRIMARY KEY,
      sub        TEXT REFERENCES users(sub) ON DELETE SET NULL,
      first_seen INTEGER NOT NULL,
      seen_at    INTEGER NOT NULL
    );
  `);
  const count = (sql, ...args) => db.query(sql).get(...args).n;
  return {
    user: (sub) => db.query("SELECT sub, email FROM users WHERE sub = ?").get(sub),
    countUsers: () => count("SELECT COUNT(*) AS n FROM users"),
    upsertUser: (sub, email, now) =>
      db
        .query(
          `INSERT INTO users (sub, email, created_at, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(sub) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at`,
        )
        .run(sub, email, now, now),
    // At most one write per user per hour, however often the page asks.
    touchUser: (sub, now) => db.query("UPDATE users SET seen_at = ? WHERE sub = ? AND seen_at < ?").run(now, sub, now - HOUR),
    /** Records a browser. New ids stop at `max`; a signed-in visit links it to the account. */
    visit(id, sub, now, max) {
      const row = db.query("SELECT sub, seen_at FROM visitors WHERE id = ?").get(id);
      if (!row) {
        if (count("SELECT COUNT(*) AS n FROM visitors") < max) {
          db.query("INSERT INTO visitors (id, sub, first_seen, seen_at) VALUES (?, ?, ?, ?)").run(id, sub, now, now);
        }
      } else if (row.seen_at < now - HOUR || (sub && row.sub !== sub)) {
        db.query("UPDATE visitors SET seen_at = ?, sub = COALESCE(?, sub) WHERE id = ?").run(now, sub, id);
      }
    },
    /** Forgets anonymous browsers not seen since `before`. */
    pruneVisitors: (before) => db.query("DELETE FROM visitors WHERE sub IS NULL AND seen_at < ?").run(before).changes,
    /** Everything /metrics reports from the database. */
    stats(now, topUsers) {
      const windows = { "1d": now - DAY, "7d": now - 7 * DAY, "30d": now - 30 * DAY };
      const perWindow = (sql) => Object.fromEntries(Object.entries(windows).map(([w, since]) => [w, count(sql, since)]));
      const sizes = db.query("SELECT length(CAST(data AS BLOB)) AS bytes FROM states").all().map((r) => r.bytes);
      return {
        users: count("SELECT COUNT(*) AS n FROM users"),
        usersCreated: perWindow("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?"),
        usersActive: perWindow("SELECT COUNT(*) AS n FROM users WHERE seen_at >= ?"),
        visitors: count("SELECT COUNT(*) AS n FROM visitors"),
        anonymous: count("SELECT COUNT(*) AS n FROM visitors WHERE sub IS NULL"),
        anonymousActive: perWindow("SELECT COUNT(*) AS n FROM visitors WHERE sub IS NULL AND seen_at >= ?"),
        anonymousNew: perWindow("SELECT COUNT(*) AS n FROM visitors WHERE sub IS NULL AND first_seen >= ?"),
        sizes,
        top: db
          .query(
            `SELECT users.email AS email, length(CAST(states.data AS BLOB)) AS bytes
             FROM states JOIN users USING (sub) ORDER BY bytes DESC LIMIT ?`,
          )
          .all(topUsers),
      };
    },
    state: (sub) => db.query("SELECT data, updated_at FROM states WHERE sub = ?").get(sub),
    putState: (sub, data, updatedAt) =>
      db
        .query(
          `INSERT INTO states (sub, data, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(sub) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(sub, data, updatedAt),
    deleteUser: (sub) => db.query("DELETE FROM users WHERE sub = ?").run(sub),
    close: () => db.close(),
  };
}
