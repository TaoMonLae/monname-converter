-- ============================================================
-- Mon Names Converter — Make names.mon nullable
-- ============================================================
-- The initial schema declared mon TEXT NOT NULL, but the worker
-- allows admin to create name entries without a Mon-script field
-- (e.g. a name known only in its English or Burmese form).
-- Attempting to save such an entry triggers a NOT NULL constraint
-- violation in D1.
--
-- SQLite does not support ALTER COLUMN to change nullability, so
-- we recreate the table with the same data and updated constraint.
-- All indexes are rebuilt afterwards.
-- ============================================================

-- Step 1: Create replacement table with mon as nullable
CREATE TABLE names_v2 (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  mon         TEXT,                              -- now nullable
  burmese     TEXT,
  english     TEXT,
  meaning     TEXT,
  gender      TEXT     NOT NULL DEFAULT 'neutral'
              CHECK(gender IN ('male', 'female', 'neutral')),
  verified    INTEGER  NOT NULL DEFAULT 0
              CHECK(verified IN (0, 1)),
  created_at  TEXT     NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT     NOT NULL DEFAULT (datetime('now'))
);

-- Step 2: Copy all existing rows
INSERT INTO names_v2 (id, mon, burmese, english, meaning, gender, verified, created_at, updated_at)
SELECT id, mon, burmese, english, meaning, gender, verified, created_at, updated_at
FROM names;

-- Step 3: Swap tables
DROP TABLE names;
ALTER TABLE names_v2 RENAME TO names;

-- Step 4: Rebuild indexes (dropped with the old table)
CREATE INDEX IF NOT EXISTS idx_names_mon      ON names(mon);
CREATE INDEX IF NOT EXISTS idx_names_burmese  ON names(burmese);
CREATE INDEX IF NOT EXISTS idx_names_english  ON names(english);
CREATE INDEX IF NOT EXISTS idx_names_verified ON names(verified);
CREATE INDEX IF NOT EXISTS idx_names_gender   ON names(gender);
CREATE INDEX IF NOT EXISTS idx_names_verified_created
  ON names(verified, created_at DESC);

-- Unique index: NULLs are treated as DISTINCT in SQLite UNIQUE indexes,
-- so multiple rows with (NULL, english) are allowed — acceptable given
-- that the CSV seeder always supplies a mon value.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_names_mon_english
  ON names(mon, english);
