-- ============================================================
-- Add optional variant-family metadata to aliases
-- ============================================================
-- This is a foundation for alternate romanization families, e.g.
-- Aung / Ong / Oung, while preserving one preferred display form.

ALTER TABLE aliases ADD COLUMN preferred INTEGER NOT NULL DEFAULT 0
  CHECK(preferred IN (0, 1));
ALTER TABLE aliases ADD COLUMN variant_group TEXT;
ALTER TABLE aliases ADD COLUMN usage_note TEXT;

CREATE INDEX IF NOT EXISTS idx_aliases_variant_group ON aliases(variant_group);

