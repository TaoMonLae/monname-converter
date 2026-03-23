-- ============================================================
-- Add normalized output variants for names
-- ============================================================
-- Input aliases remain in aliases (for lookup/matching).
-- Output variants are modeled separately for user-selectable rendering.

CREATE TABLE IF NOT EXISTS name_output_variants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name_id      INTEGER NOT NULL REFERENCES names(id) ON DELETE CASCADE,
  target_lang  TEXT    NOT NULL CHECK(target_lang IN ('mon', 'burmese', 'english')),
  target_text  TEXT    NOT NULL,
  preferred    INTEGER NOT NULL DEFAULT 0 CHECK(preferred IN (0, 1)),
  verified     INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0, 1)),
  label        TEXT,
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_name_output_variants_unique
  ON name_output_variants(name_id, target_lang, target_text);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_name_output_variants_one_preferred
  ON name_output_variants(name_id, target_lang)
  WHERE preferred = 1;

CREATE INDEX IF NOT EXISTS idx_name_output_variants_lookup
  ON name_output_variants(name_id, target_lang, preferred DESC, verified DESC, target_text ASC);
