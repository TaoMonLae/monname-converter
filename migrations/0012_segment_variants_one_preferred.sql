-- ============================================================
-- Ensure one preferred segment output variant per segment+target
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uidx_segment_variants_one_preferred
  ON segment_variants(segment_id, target_lang)
  WHERE preferred = 1;
