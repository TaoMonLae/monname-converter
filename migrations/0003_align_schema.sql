-- ============================================================
-- Mon Names Converter — Align schema with application code
-- ============================================================
-- Fixes mismatches between migrations/0001 and worker.js:
--   • Rename name_aliases  → aliases  (worker queries FROM aliases)
--   • Rename notes         → meaning  (worker SELECTs n.meaning)
--   • Add gender, admin_notes, updated_at to suggestions
--   • Recreate admin_sessions without the unused admin_id FK
--   • Add UNIQUE constraints to support CSV-based INSERT OR IGNORE seeding
-- ============================================================

-- ── 1. Rename name_aliases → aliases ────────────────────────
ALTER TABLE name_aliases RENAME TO aliases;

-- ── 2. Rename names.notes → names.meaning ───────────────────
ALTER TABLE names RENAME COLUMN notes TO meaning;

-- ── 3. Add missing columns to suggestions ───────────────────
ALTER TABLE suggestions ADD COLUMN gender      TEXT NOT NULL DEFAULT 'neutral'
  CHECK(gender IN ('male', 'female', 'neutral'));
ALTER TABLE suggestions ADD COLUMN meaning     TEXT;  -- mirrors names.meaning
ALTER TABLE suggestions ADD COLUMN admin_notes TEXT;
ALTER TABLE suggestions ADD COLUMN updated_at  TEXT NOT NULL DEFAULT (datetime('now'));

-- ── 4. Recreate admin_sessions without the admin_id FK ──────
-- The application authenticates via the ADMIN_PASSWORD env var,
-- so admin_id is never populated and causes INSERT failures.
DROP TABLE IF EXISTS admin_sessions;
CREATE TABLE admin_sessions (
  token       TEXT  PRIMARY KEY,
  created_at  TEXT  NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

-- ── 5. UNIQUE constraints to enable INSERT OR IGNORE seeding ─
-- Prevent duplicate names when the CSV seed is re-applied.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_names_mon_english
  ON names(mon, english);

-- Prevent duplicate alias rows when seed is re-applied.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_aliases_name_alias_lang
  ON aliases(name_id, alias, language);
