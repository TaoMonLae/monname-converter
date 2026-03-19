-- ============================================================
-- Mon Names Converter — Cleanup / consistency fixes
-- ============================================================
-- After migrations 0001–0004 the suggestions table has two
-- overlapping text columns: `notes` (from 0001) and `meaning`
-- (added in 0003).  The worker has always used `meaning`, so
-- `notes` is unreferenced.  Drop it to keep the schema clean.
--
-- SQLite 3.35+ (supported by Cloudflare D1) allows DROP COLUMN
-- when the column is not used in an index, a UNIQUE constraint,
-- a CHECK constraint, or a PRIMARY KEY.
-- ============================================================

ALTER TABLE suggestions DROP COLUMN notes;
