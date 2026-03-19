/**
 * Mon Names Converter — Cloudflare Worker
 * =========================================
 * Handles all /api/* routes. Everything else is served from /public via
 * the Cloudflare Assets binding (env.ASSETS).
 *
 * Public API
 *   GET  /api/search?q=&lang=       Search names across all three languages
 *   POST /api/suggestions           Submit a name suggestion for review
 *
 * Admin API  (requires: admin_session HttpOnly cookie)
 *   POST   /api/admin/login                  Authenticate with ADMIN_PASSWORD
 *   POST   /api/admin/logout                 Invalidate session and clear cookie
 *   GET    /api/admin/stats                  Dashboard counts (total, verified, pending)
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
 * Attach CORS headers to any Response, preserving existing headers (e.g.
 * Set-Cookie from login/logout). Public routes use wildcard origin; cookie
 * auth only matters for same-origin admin requests anyway.
 */
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
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

/**
 * Normalize a search query: trim surrounding whitespace, collapse internal
 * runs of whitespace to a single space.
 */
function normalize(q) {
  return (q || '').replace(/\s+/g, ' ').trim();
}

/** Read a named cookie value from the request. */
function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    if (k === name) return part.slice(eqIdx + 1).trim();
  }
  return null;
}

/** Build a Set-Cookie string for the admin session token. */
function sessionCookie(token, maxAge = 86400) {
  return `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Auth Middleware ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate the admin_session cookie.
 * Returns null when auth is valid, or a 401 Response when invalid/missing.
 */
async function requireAdmin(request, env) {
  const token = getCookie(request, 'admin_session');
  if (!token) return err('Not authenticated', 401);

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
 * Searches names and aliases with ranked results:
 *   1. Verified names first
 *   2. Exact match
 *   3. Prefix match (starts with)
 *   4. Partial match (contains)
 * Maximum 25 results. Safe bound parameters throughout.
 */
async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = normalize(url.searchParams.get('q'));
  const lang = url.searchParams.get('lang') || 'all';

  if (!q) return json({ results: [] });
  if (q.length > 100) return err('Query too long (max 100 characters)');

  const exact   = q;
  const prefix  = `${q}%`;
  const partial = `%${q}%`;

  let sql, bindings;

  if (lang === 'mon') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.mon = ? THEN 0 WHEN n.mon LIKE ? THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.mon LIKE ?
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'mon' AND a.alias LIKE ?)
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];

  } else if (lang === 'burmese') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.burmese = ? THEN 0 WHEN n.burmese LIKE ? THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.burmese LIKE ?
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'burmese' AND a.alias LIKE ?)
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];

  } else if (lang === 'english') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.english = ? THEN 0 WHEN n.english LIKE ? THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.english LIKE ?
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'english' AND a.alias LIKE ?)
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];

  } else {
    // All languages — rank by best match across any column
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE
          WHEN n.mon = ? OR n.burmese = ? OR n.english = ? THEN 0
          WHEN n.mon LIKE ? OR n.burmese LIKE ? OR n.english LIKE ? THEN 1
          ELSE 2
        END AS match_rank
      FROM names n
      WHERE (
        n.mon LIKE ? OR n.burmese LIKE ? OR n.english LIKE ?
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.alias LIKE ?)
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [
      exact, exact, exact,        // CASE exact checks
      prefix, prefix, prefix,     // CASE prefix checks
      partial, partial, partial, partial, // WHERE partial checks (mon, bur, eng, alias)
    ];
  }

  try {
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    return json({ results: results.map(formatName) });
  } catch (e) {
    console.error('Search error:', e);
    return err('Search failed', 500);
  }
}

/**
 * POST /api/suggestions
 * Body: { mon, burmese, english, meaning, gender, submitted_by,
 *         aliases: [{alias, language}] }
 *
 * At least one of mon/burmese/english must be provided.
 * Submission goes to `suggestions` with status = 'pending'.
 * Aliases are stored as JSON in aliases_json for later promotion.
 */
async function handleSuggest(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { mon, burmese, english, meaning, gender, submitted_by, aliases } = body;

  if (!mon && !burmese && !english) {
    return err('At least one name field (Mon, Burmese, or English) is required');
  }

  const validGenders = ['male', 'female', 'neutral'];
  const safeGender = validGenders.includes(gender) ? gender : 'neutral';

  // Validate and serialise aliases for storage
  let aliasesJson = null;
  if (Array.isArray(aliases) && aliases.length > 0) {
    const validLangs = ['mon', 'burmese', 'english'];
    const clean = aliases
      .filter(a => a && typeof a.alias === 'string' && a.alias.trim())
      .map(a => ({
        alias: a.alias.trim(),
        language: validLangs.includes(a.language) ? a.language : 'english',
      }));
    if (clean.length > 0) aliasesJson = JSON.stringify(clean);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO suggestions (mon, burmese, english, meaning, gender, submitted_by, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mon || null, burmese || null, english || null,
      meaning || null, safeGender, submitted_by || null, aliasesJson
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
 * On success, sets an HttpOnly admin_session cookie (24 h).
 */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    return err('Invalid password', 401);
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

  await env.DB.prepare(
    `INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)`
  ).bind(token, expiresAt).run();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie(token),
    },
  });
}

/**
 * POST /api/admin/logout
 * Deletes the session from D1 and clears the cookie.
 */
async function handleLogout(request, env) {
  const token = getCookie(request, 'admin_session');
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie('', 0), // expire the cookie immediately
    },
  });
}

/**
 * GET /api/admin/stats
 * Returns total names, total verified names, and pending suggestion count.
 * Used by the admin dashboard to populate stat cards accurately.
 */
async function handleAdminStats(request, env) {
  const [totalRow, verifiedRow, pendingRow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM names').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM names WHERE verified = 1').first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM suggestions WHERE status = 'pending'").first(),
  ]);

  return json({
    total: totalRow.count,
    totalVerified: verifiedRow.count,
    pendingSuggestions: pendingRow.count,
  });
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

  // Full alias replacement when aliases key is present
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
 * Explicitly removes aliases before deleting the name, as belt-and-suspenders
 * in case the D1 instance has foreign key enforcement off.
 */
async function handleDeleteName(request, env, id) {
  await env.DB.prepare('DELETE FROM aliases WHERE name_id = ?').bind(id).run();
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
 * Approving a suggestion automatically:
 *   1. Creates a verified entry in `names`
 *   2. Promotes aliases_json into the `aliases` table
 *   3. Marks the suggestion as approved
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

  if (status === 'approved') {
    const s = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
    if (s) {
      const result = await env.DB.prepare(`
        INSERT INTO names (mon, burmese, english, meaning, gender, verified)
        VALUES (?, ?, ?, ?, ?, 1)
      `).bind(s.mon, s.burmese, s.english, s.meaning, s.gender || 'neutral').run();

      const nameId = result.meta.last_row_id;

      // Promote suggestion aliases into the aliases table
      if (s.aliases_json) {
        let aliases;
        try { aliases = JSON.parse(s.aliases_json); } catch { aliases = []; }
        const validLangs = ['mon', 'burmese', 'english'];
        for (const { alias, language } of (aliases || [])) {
          if (alias && validLangs.includes(language)) {
            await env.DB.prepare(
              'INSERT INTO aliases (name_id, alias, language) VALUES (?, ?, ?)'
            ).bind(nameId, alias.trim(), language).run();
          }
        }
      }
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
  if (method === 'GET'  && pathname === '/api/search')      return handleSearch(request, env);
  if (method === 'POST' && pathname === '/api/suggestions') return handleSuggest(request, env);

  // ── Admin auth (no session required) ────────────────────────────────────
  if (method === 'POST' && pathname === '/api/admin/login')  return handleLogin(request, env);
  if (method === 'POST' && pathname === '/api/admin/logout') return handleLogout(request, env);

  // ── Protected admin routes ───────────────────────────────────────────────
  if (pathname.startsWith('/api/admin/')) {
    const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

    // Stats
    if (method === 'GET' && pathname === '/api/admin/stats') return handleAdminStats(request, env);

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

  // ── Unknown /api/* ───────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) return err('Not found', 404);

  // ── Static assets ────────────────────────────────────────────────────────
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
