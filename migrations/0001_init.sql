-- ============================================================
-- Mon Names Converter — Initial Schema
-- Cloudflare D1 / SQLite-compatible
-- Run: npm run db:migrate:local  (dev)
--      npm run db:migrate:remote (production)
-- ============================================================

-- ── Core names table ────────────────────────────────────────
-- Stores verified Mon name entries with multilingual fields.
CREATE TABLE IF NOT EXISTS names (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  mon         TEXT     NOT NULL,                 -- Name in Mon script
  burmese     TEXT,                              -- Name in Burmese/Myanmar script
  english     TEXT,                              -- Romanised / English spelling
  notes       TEXT,                              -- Meaning, usage notes, or description
  gender      TEXT     NOT NULL DEFAULT 'neutral'
              CHECK(gender IN ('male', 'female', 'neutral')),
  verified    INTEGER  NOT NULL DEFAULT 0        -- 1 = admin-verified, 0 = draft
              CHECK(verified IN (0, 1)),
  created_at  TEXT     NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT     NOT NULL DEFAULT (datetime('now'))
);

-- ── Per-language aliases / alternate spellings ───────────────
-- Normalised relation — each row is one alternate form of a name.
-- Avoids embedding a JSON blob in the names row, enabling:
--   • exact-match and prefix searches on individual aliases
--   • per-language filtering without JSON parsing
--   • simple INSERT/DELETE without serialising the whole array
CREATE TABLE IF NOT EXISTS name_aliases (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  name_id     INTEGER  NOT NULL
              REFERENCES names(id) ON DELETE CASCADE,
  alias       TEXT     NOT NULL,
  language    TEXT     NOT NULL
              CHECK(language IN ('mon', 'burmese', 'english')),
  created_at  TEXT     NOT NULL DEFAULT (datetime('now'))
);

-- ── User-submitted suggestions ──────────────────────────────
-- Holds unverified entries submitted by visitors.
-- aliases_json stores proposed aliases as a JSON array so the
-- entire suggestion is self-contained before admin review;
-- once approved the row is promoted to names + name_aliases.
CREATE TABLE IF NOT EXISTS suggestions (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  mon           TEXT,
  burmese       TEXT,
  english       TEXT,
  aliases_json  TEXT,                            -- e.g. [{"alias":"Naing Kya","language":"english"}]
  notes         TEXT,
  submitted_by  TEXT,                            -- optional name / e-mail
  status        TEXT     NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending', 'approved', 'rejected')),
  created_at    TEXT     NOT NULL DEFAULT (datetime('now'))
);

-- ── Admin accounts ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  username      TEXT     NOT NULL UNIQUE,
  password_hash TEXT     NOT NULL,               -- bcrypt / argon2id hash — never plaintext
  created_at    TEXT     NOT NULL DEFAULT (datetime('now'))
);

-- ── Admin sessions ───────────────────────────────────────────
-- Short-lived bearer tokens issued on login.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT  PRIMARY KEY,
  admin_id    INTEGER NOT NULL
              REFERENCES admins(id) ON DELETE CASCADE,
  created_at  TEXT  NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT  NOT NULL
);

-- ── Seed data ────────────────────────────────────────────────
INSERT OR IGNORE INTO names (id, mon, burmese, english, notes, gender, verified) VALUES
  (1, 'နာင်ဗြာ',  'နောင်ကြာ',  'Naing Kyar',  'Future brightness; long-lasting glory',  'male',    1),
  (2, 'မတ်ထဝ်',  'မသိုး',     'Ma Thoe',     'Shining one; luminous',                   'female',  1),
  (3, 'မိဥ်ꩫ်',   'မင်းသည်',  'Min Thi',     'Royalty; nobility of character',           'male',    1),
  (4, 'ဍုင်',     'မြို့',      'Dung',        'City; homeland; place of origin',         'neutral', 1),
  (5, 'ဗြဲ',      'ကြယ်',      'Hkre',        'Star; celestial light',                   'neutral', 1),
  (6, 'မိစိုတ်',  'မသက်',     'Mi Sot',      'Living; full of life and vitality',        'female',  1),
  (7, 'နာင်ꩦ်',  'နောင်ထွတ်', 'Naing Htut',  'Future peak; rising high',                'male',    1),
  (8, 'ဒြဲ',      'ကြဲ',       'Hkre',        'Brave; courageous spirit',                'male',    1);

INSERT OR IGNORE INTO name_aliases (name_id, alias, language) VALUES
  (1, 'Naing Kya',   'english'),
  (1, 'Naing Kyar',  'english'),
  (2, 'Ma Toe',      'english'),
  (3, 'Min Thi',     'english'),
  (3, 'Min Ti',      'english'),
  (5, 'Kre',         'english'),
  (7, 'Naing Htoot', 'english');
