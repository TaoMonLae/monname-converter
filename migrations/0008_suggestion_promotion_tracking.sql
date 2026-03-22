-- ============================================================
-- Track suggestion -> approved name promotion for idempotent review
-- ============================================================

ALTER TABLE suggestions ADD COLUMN approved_name_id INTEGER
  REFERENCES names(id) ON DELETE SET NULL;

-- Timestamp of the most recent review action (approve/reject/pending update).
ALTER TABLE suggestions ADD COLUMN reviewed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_suggestions_approved_name_id
  ON suggestions(approved_name_id);
