-- ============================================================
-- Mon Names Converter — Admin login rate-limit tracking
-- ============================================================
-- Stores failed admin login attempts by client IP so the worker
-- can enforce a rolling window limit for /api/admin/login.
--
-- Keeping this D1-based avoids external services and works in
-- both local wrangler dev and deployed Worker environments.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_login_failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ip           TEXT    NOT NULL,
  attempted_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_login_failures_ip_attempted_at
  ON admin_login_failures(ip, attempted_at);
