/**
 * Database Migration System
 * Ensures schema updates don't break historic data.
 * Each migration runs once and is tracked by version number.
 */

import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS db_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const MIGRATIONS = [
  {
    version: 1,
    name: "initial_schema",
    up: () => {
      // Already handled by db.js — this is just the marker
    },
  },
  {
    version: 2,
    name: "add_stakeholder_confidence",
    up: () => {
      db.exec(`
        ALTER TABLE email_sequences ADD COLUMN stakeholder_confidence TEXT DEFAULT 'unknown';
        ALTER TABLE email_sequences ADD COLUMN linkedin_url TEXT;
      `);
    },
  },
  {
    version: 3,
    name: "add_sequence_paused_status",
    up: () => {
      // email_steps already has status field that can be 'paused'
      // Just ensure the index exists
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sequences_status ON email_sequences(status);
      `);
    },
  },
  {
    version: 4,
    name: "add_shortlist_approval",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shortlist_approvals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_number TEXT NOT NULL,
          week_label TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          notes TEXT,
          approved_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(company_number, week_label)
        );
        CREATE INDEX IF NOT EXISTS idx_approvals_week ON shortlist_approvals(week_label);
        CREATE INDEX IF NOT EXISTS idx_approvals_status ON shortlist_approvals(status);
      `);
    },
  },
  {
    version: 5,
    name: "add_analysis_queue",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analysis_queue (
          company_number TEXT PRIMARY KEY,
          company_name TEXT,
          turnover REAL,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT,
          queued_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_analysis_queue_status ON analysis_queue(status);
      `);
    },
  },
];

export function runMigrations() {
  const applied = db.prepare("SELECT version FROM db_migrations").all().map((r) => r.version);

  let newMigrations = 0;
  for (const migration of MIGRATIONS) {
    if (applied.includes(migration.version)) continue;

    try {
      migration.up();
      db.prepare("INSERT INTO db_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
      newMigrations++;
      console.log(`Migration ${migration.version} applied: ${migration.name}`);
    } catch (err) {
      if (err.message.includes("duplicate column") || err.message.includes("already exists")) {
        db.prepare("INSERT OR IGNORE INTO db_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
        continue;
      }
      console.error(`Migration ${migration.version} failed: ${err.message}`);
    }
  }

  if (newMigrations > 0) {
    console.log(`${newMigrations} migration(s) applied successfully`);
  }

  return { applied: newMigrations, total: MIGRATIONS.length };
}

export function getMigrationStatus() {
  const applied = db.prepare("SELECT * FROM db_migrations ORDER BY version").all();
  return {
    current_version: applied.length > 0 ? applied[applied.length - 1].version : 0,
    total_migrations: MIGRATIONS.length,
    applied: applied,
    pending: MIGRATIONS.filter((m) => !applied.find((a) => a.version === m.version)).map((m) => m.name),
  };
}
