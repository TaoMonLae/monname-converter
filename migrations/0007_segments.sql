-- ============================================================
-- Mon Names Converter — Structured segment dictionary
-- ============================================================
-- Adds normalized segment tables for dictionary-first longest-match
-- conversion. This complements the existing names + aliases tables.
--
-- Naming convention kept consistent with existing schema:
--   aliases, meaning, suggestions
-- ============================================================

CREATE TABLE IF NOT EXISTS segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text  TEXT    NOT NULL,
  source_lang  TEXT    NOT NULL CHECK(source_lang IN ('mon', 'burmese', 'english')),
  meaning      TEXT,
  verified     INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_segments_source_lang_text
  ON segments(source_lang, source_text);

CREATE INDEX IF NOT EXISTS idx_segments_source_lookup
  ON segments(source_lang, source_text);

CREATE TABLE IF NOT EXISTS segment_variants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id   INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  target_lang  TEXT    NOT NULL CHECK(target_lang IN ('mon', 'burmese', 'english')),
  target_text  TEXT    NOT NULL,
  preferred    INTEGER NOT NULL DEFAULT 0 CHECK(preferred IN (0, 1)),
  verified     INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0, 1)),
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_segment_variants_unique
  ON segment_variants(segment_id, target_lang, target_text);

CREATE INDEX IF NOT EXISTS idx_segment_variants_lookup
  ON segment_variants(segment_id, target_lang, preferred DESC, verified DESC);
