-- ============================================================
-- Mon Names Converter — Indexes
-- Kept in a separate migration so they can be tuned or
-- dropped/rebuilt without touching the schema itself.
-- ============================================================

-- ── names ────────────────────────────────────────────────────
-- Support full-column lookups on each script field.
-- D1/SQLite will use these for both equality and LIKE 'prefix%' scans.
CREATE INDEX IF NOT EXISTS idx_names_mon      ON names(mon);
CREATE INDEX IF NOT EXISTS idx_names_burmese  ON names(burmese);
CREATE INDEX IF NOT EXISTS idx_names_english  ON names(english);

-- Filter by verification status (e.g. WHERE verified = 1).
CREATE INDEX IF NOT EXISTS idx_names_verified ON names(verified);

-- Filter by gender (e.g. WHERE gender = 'female').
CREATE INDEX IF NOT EXISTS idx_names_gender   ON names(gender);

-- Covering index for the common admin list query:
--   SELECT * FROM names WHERE verified = 0 ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_names_verified_created
  ON names(verified, created_at DESC);

-- ── name_aliases ─────────────────────────────────────────────
-- Look up all aliases belonging to a parent name (JOIN / cascade).
CREATE INDEX IF NOT EXISTS idx_name_aliases_name_id ON name_aliases(name_id);

-- Search aliases directly (e.g. search bar hits aliases too).
CREATE INDEX IF NOT EXISTS idx_name_aliases_alias   ON name_aliases(alias);

-- Filter aliases by language (e.g. WHERE language = 'english').
CREATE INDEX IF NOT EXISTS idx_name_aliases_language ON name_aliases(language);

-- ── suggestions ──────────────────────────────────────────────
-- Admin review queue: WHERE status = 'pending' ORDER BY created_at ASC
CREATE INDEX IF NOT EXISTS idx_suggestions_status         ON suggestions(status);
CREATE INDEX IF NOT EXISTS idx_suggestions_status_created ON suggestions(status, created_at);

-- ── admin_sessions ───────────────────────────────────────────
-- Expire-check: WHERE expires_at < datetime('now')
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
