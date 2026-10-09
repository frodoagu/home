// SQLite on the PVC: one row per user, one JSON workspace per user. WAL keeps
// writes small and lets a rolling pod read while the old one finishes.
import { Database } from "bun:sqlite";

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
  `);
  return {
    user: (sub) => db.query("SELECT sub, email FROM users WHERE sub = ?").get(sub),
    countUsers: () => db.query("SELECT COUNT(*) AS n FROM users").get().n,
    upsertUser: (sub, email, now) =>
      db
        .query(
          `INSERT INTO users (sub, email, created_at, seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(sub) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at`,
        )
        .run(sub, email, now, now),
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
