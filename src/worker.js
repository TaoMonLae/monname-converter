/**
 * Mon Names Converter — Cloudflare Worker
 * =========================================
 * Handles all /api/* routes. Everything else is served from /public via
 * the Cloudflare Assets binding (env.ASSETS).
 *
 * Public API
 *   GET  /api/search?q=&lang=       Search names across all three languages
 *   POST /api/suggest               Submit a name suggestion for review
 *
 * Admin API  (requires: Authorization: Bearer <token>)
 *   POST   /api/admin/login                  Authenticate with ADMIN_PASSWORD
 *   POST   /api/admin/logout                 Invalidate session token
 *   GET    /api/admin/names?page=            List all name entries (paginated)
 *   POST   /api/admin/names                  Create a new name entry
 *   PUT    /api/admin/names/:id              Update an existing name entry
 *   DELETE /api/admin/names/:id              Delete a name entry
 *   GET    /api/admin/suggestions?status=    List suggestions (pending|approved|rejected)
 *   PUT    /api/admin/suggestions/:id        Approve, reject, or update a suggestion
 */

// ═══════════════════════════════════════════════════════════════════════════
// ── Utilities ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/** Respond with JSON and optional HTTP status code. */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Shorthand for JSON error responses. */
const err = (message, status = 400) => json({ error: message }, status);

/**
 * Attach CORS headers to any Response.
 * In production you may want to restrict Allow-Origin to your domain.
 */
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

/** Generate a cryptographically random 64-hex-char token. */
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Parse aliases from the GROUP_CONCAT format "alias~~language||alias~~language". */
function parseAliases(raw) {
  if (!raw) return [];
  return raw.split('||').map(part => {
    const [alias, language] = part.split('~~');
    return { alias, language };
  });
}

/** Format a name row: booleanise `verified` and expand aliases string. */
function formatName(row) {
  return { ...row, verified: !!row.verified, aliases: parseAliases(row.aliases) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Auth Middleware ─────────────────────────────────────────════════════════
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate the Bearer token in the Authorization header.
 * Returns null when auth is valid, or a 401 Response when invalid.
 */
async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  if (!token) return err('Missing authorization token', 401);

  const session = await env.DB.prepare(
    `SELECT token FROM admin_sessions
     WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();

  if (!session) return err('Invalid or expired session', 401);
  return null; // ✓ authorised
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Public Handlers ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/search?q=<query>&lang=<all|mon|burmese|english>
 *
 * Searches the `names` table and `aliases` table using a LIKE query.
 * Results are ordered: verified first, then alphabetically by English.
 */
async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const lang = url.searchParams.get('lang') || 'all';

  if (!q) return json({ results: [] });
  if (q.length > 100) return err('Query too long (max 100 characters)');

  const like = `%${q}%`;

  // Build WHERE clause and binding array based on language filter
  let where, bindings;
  if (lang === 'mon') {
    where = `WHERE (n.mon LIKE ?
      OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'mon' AND a.alias LIKE ?))`;
    bindings = [like, like];
  } else if (lang === 'burmese') {
    where = `WHERE (n.burmese LIKE ?
      OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'burmese' AND a.alias LIKE ?))`;
    bindings = [like, like];
  } else if (lang === 'english') {
    where = `WHERE (n.english LIKE ?
      OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'english' AND a.alias LIKE ?))`;
    bindings = [like, like];
  } else {
    where = `WHERE (
      n.mon LIKE ? OR n.burmese LIKE ? OR n.english LIKE ?
      OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.alias LIKE ?)
    )`;
    bindings = [like, like, like, like];
  }

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases
      FROM names n
      ${where}
      ORDER BY n.verified DESC, n.english ASC
      LIMIT 20
    `).bind(...bindings).all();

    return json({ results: results.map(formatName) });
  } catch (e) {
    console.error('Search error:', e);
    return err('Search failed', 500);
  }
}

/**
 * POST /api/suggest
 * Body: { mon, burmese, english, meaning, gender, submitted_by }
 *
 * At least one of mon/burmese/english must be provided.
 * Submission goes to `suggestions` with status = 'pending'.
 */
async function handleSuggest(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { mon, burmese, english, meaning, gender, submitted_by } = body;

  if (!mon && !burmese && !english) {
    return err('At least one name field (Mon, Burmese, or English) is required');
  }

  const validGenders = ['male', 'female', 'neutral'];
  const safeGender = validGenders.includes(gender) ? gender : 'neutral';

  try {
    await env.DB.prepare(`
      INSERT INTO suggestions (mon, burmese, english, meaning, gender, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      mon || null, burmese || null, english || null,
      meaning || null, safeGender, submitted_by || null
    ).run();

    return json({ success: true, message: 'Thank you! Your suggestion has been submitted for review.' }, 201);
  } catch (e) {
    console.error('Suggest error:', e);
    return err('Failed to save suggestion', 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Admin Handlers ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/login
 * Body: { password }
 * Returns: { token } — store this and send as "Authorization: Bearer <token>"
 */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    // Constant-time-ish: always check even if missing
    return err('Invalid password', 401);
  }

  const token = randomToken();
  // SQLite datetime() doesn't accept JS ISO strings directly; use strftime
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  await env.DB.prepare(
    `INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)`
  ).bind(token, expiresAt).run();

  return json({ token });
}

/**
 * POST /api/admin/logout
 * Deletes the session token from D1.
 */
async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
  }
  return json({ success: true });
}

/**
 * GET /api/admin/names?page=<n>
 * Returns paginated list of all name entries including their aliases.
 */
async function handleListNames(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 50;
  const offset = (page - 1) * limit;

  const [{ results }, countRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified, n.created_at,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases
      FROM names n
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM names').first(),
  ]);

  return json({
    results: results.map(formatName),
    total: countRow.count,
    page,
    limit,
    totalPages: Math.ceil(countRow.count / limit),
  });
}

/**
 * POST /api/admin/names
 * Body: { mon, burmese, english, meaning, gender, verified, aliases: [{alias, language}] }
 */
async function handleCreateName(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { mon, burmese, english, meaning, gender, verified, aliases } = body;
  if (!mon && !burmese && !english) return err('At least one name field is required');

  const validGenders = ['male', 'female', 'neutral'];
  const safeGender = validGenders.includes(gender) ? gender : 'neutral';

  const result = await env.DB.prepare(`
    INSERT INTO names (mon, burmese, english, meaning, gender, verified)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    mon || null, burmese || null, english || null,
    meaning || null, safeGender, verified ? 1 : 0
  ).run();

  const nameId = result.meta.last_row_id;

  if (Array.isArray(aliases) && aliases.length > 0) {
    for (const { alias, language } of aliases) {
      if (alias && ['mon', 'burmese', 'english'].includes(language)) {
        await env.DB.prepare(
          'INSERT INTO aliases (name_id, alias, language) VALUES (?, ?, ?)'
        ).bind(nameId, alias.trim(), language).run();
      }
    }
  }

  return json({ success: true, id: nameId }, 201);
}

/**
 * PUT /api/admin/names/:id
 * Body: { mon, burmese, english, meaning, gender, verified, aliases }
 * Replaces all aliases with the provided array.
 */
async function handleUpdateName(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { mon, burmese, english, meaning, gender, verified, aliases } = body;
  const validGenders = ['male', 'female', 'neutral'];
  const safeGender = validGenders.includes(gender) ? gender : 'neutral';

  await env.DB.prepare(`
    UPDATE names
    SET mon = ?, burmese = ?, english = ?, meaning = ?,
        gender = ?, verified = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    mon || null, burmese || null, english || null,
    meaning || null, safeGender, verified ? 1 : 0, id
  ).run();

  // Full alias replacement
  if (aliases !== undefined) {
    await env.DB.prepare('DELETE FROM aliases WHERE name_id = ?').bind(id).run();
    if (Array.isArray(aliases)) {
      for (const { alias, language } of aliases) {
        if (alias && ['mon', 'burmese', 'english'].includes(language)) {
          await env.DB.prepare(
            'INSERT INTO aliases (name_id, alias, language) VALUES (?, ?, ?)'
          ).bind(id, alias.trim(), language).run();
        }
      }
    }
  }

  return json({ success: true });
}

/**
 * DELETE /api/admin/names/:id
 * Cascades to aliases via FK constraint.
 */
async function handleDeleteName(request, env, id) {
  await env.DB.prepare('DELETE FROM names WHERE id = ?').bind(id).run();
  return json({ success: true });
}

/**
 * GET /api/admin/suggestions?status=pending|approved|rejected
 */
async function handleListSuggestions(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const validStatuses = ['pending', 'approved', 'rejected'];
  if (!validStatuses.includes(status)) return err('Invalid status filter');

  const { results } = await env.DB.prepare(`
    SELECT * FROM suggestions WHERE status = ?
    ORDER BY created_at DESC LIMIT 100
  `).bind(status).all();

  return json({ results });
}

/**
 * PUT /api/admin/suggestions/:id
 * Body: { status: 'approved'|'rejected'|'pending', admin_notes }
 *
 * Approving a suggestion automatically creates a verified entry in `names`.
 */
async function handleUpdateSuggestion(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { status, admin_notes } = body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return err('status must be pending, approved, or rejected');
  }

  await env.DB.prepare(`
    UPDATE suggestions
    SET status = ?, admin_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, admin_notes || null, id).run();

  // Auto-promote approved suggestions into the names table
  if (status === 'approved') {
    const s = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
    if (s) {
      await env.DB.prepare(`
        INSERT INTO names (mon, burmese, english, meaning, gender, verified)
        VALUES (?, ?, ?, ?, ?, 1)
      `).bind(s.mon, s.burmese, s.english, s.meaning, s.gender || 'neutral').run();
    }
  }

  return json({ success: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Router ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function router(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  // CORS preflight
  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  // ── Public routes ───────────────────────────────────────────────────────
  if (method === 'GET'  && pathname === '/api/search')  return handleSearch(request, env);
  if (method === 'POST' && pathname === '/api/suggest') return handleSuggest(request, env);

  // ── Admin auth (no token required) ─────────────────────────────────────
  if (method === 'POST' && pathname === '/api/admin/login')  return handleLogin(request, env);
  if (method === 'POST' && pathname === '/api/admin/logout') return handleLogout(request, env);

  // ── Protected admin routes ──────────────────────────────────────────────
  if (pathname.startsWith('/api/admin/')) {
    const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

    // Names collection
    if (method === 'GET'  && pathname === '/api/admin/names') return handleListNames(request, env);
    if (method === 'POST' && pathname === '/api/admin/names') return handleCreateName(request, env);

    // Names item
    const nameMatch = pathname.match(/^\/api\/admin\/names\/(\d+)$/);
    if (nameMatch) {
      const id = parseInt(nameMatch[1], 10);
      if (method === 'PUT')    return handleUpdateName(request, env, id);
      if (method === 'DELETE') return handleDeleteName(request, env, id);
    }

    // Suggestions collection
    if (method === 'GET' && pathname === '/api/admin/suggestions') return handleListSuggestions(request, env);

    // Suggestions item
    const suggMatch = pathname.match(/^\/api\/admin\/suggestions\/(\d+)$/);
    if (suggMatch) {
      const id = parseInt(suggMatch[1], 10);
      if (method === 'PUT') return handleUpdateSuggestion(request, env, id);
    }

    return err('Admin route not found', 404);
  }

  // ── Unknown /api/* ──────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) return err('Not found', 404);

  // ── Static assets ───────────────────────────────────────────────────────
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Worker Entry Point ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router(request, env);
      return withCors(response);
    } catch (e) {
      console.error('Unhandled worker error:', e);
      return withCors(err('Internal server error', 500));
    }
  },
};
