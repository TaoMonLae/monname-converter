const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const err = (message, status = 400) => json({ error: message }, status);
const invalidPayload = details => json({ error: 'Invalid payload', details }, 400);

function requestOriginFromUrl(url) {
  return `${url.protocol}//${url.host}`;
}

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function resolveAdminCorsOrigin(request, env, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const requestOrigin = requestOriginFromUrl(url);
  if (origin === requestOrigin) return origin;

  // Optional override for admin frontends hosted on a separate origin.
  if (env.ADMIN_CORS_ORIGIN && origin === env.ADMIN_CORS_ORIGIN) return origin;

  // Keep local development flexible when using separate dev servers.
  if (isLocalhostOrigin(origin) && isLocalhostOrigin(requestOrigin)) return origin;

  return null;
}

function withCors(request, env, response) {
  const url = new URL(request.url);
  const isApiRoute = url.pathname.startsWith('/api/');
  const isAdminRoute = url.pathname.startsWith('/api/admin/');
  const headers = new Headers(response.headers);

  if (isApiRoute && !isAdminRoute) {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  } else if (isApiRoute && isAdminRoute) {
    const allowedOrigin = resolveAdminCorsOrigin(request, env, url);
    if (allowedOrigin) {
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Vary', 'Origin');
    }
  }

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (isAdminRoute) {
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(response.body, { status: response.status, headers });
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function parseAliases(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(entry => entry && typeof entry === 'object' && entry.alias)
        .map(entry => ({
          alias: entry.alias,
          language: VALID_LANGUAGES.includes(entry.language) ? entry.language : 'english',
          preferred: !!entry.preferred,
          variant_group: entry.variant_group || null,
          usage_note: entry.usage_note || null,
        }));
    }
  } catch {}

  // Backward compatibility with older delimiter-based alias payloads.
  return raw
    .split('||')
    .map(part => {
      const [alias, language] = part.split('~~');
      return { alias, language };
    })
    .filter(entry => entry.alias);
}

function parseOutputVariants(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(entry => entry && typeof entry === 'object' && entry.target_text)
      .map(entry => ({
        target_lang: VALID_LANGUAGES.includes(entry.target_lang) ? entry.target_lang : 'english',
        target_text: collapseSpaces(entry.target_text),
        preferred: !!entry.preferred,
        verified: entry.verified === undefined ? true : !!entry.verified,
        label: entry.label || null,
        notes: entry.notes || null,
      }))
      .filter(entry => entry.target_text);
  } catch {
    return [];
  }
}

function formatName(row) {
  return {
    ...row,
    verified: !!row.verified,
    aliases: parseAliases(row.aliases),
    output_variants: parseOutputVariants(row.output_variants),
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

async function handleAdminExport(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'names';
  const format = url.searchParams.get('format') || 'csv';

  if (!['names', 'suggestions', 'segments'].includes(type)) {
    return err('Invalid type. Must be: names, suggestions, or segments');
  }
  if (!['csv', 'json'].includes(format)) {
    return err('Invalid format. Must be: csv or json');
  }

  const MAX_EXPORT_ROWS = 50000;
  let data, filename, csvContent;

  if (type === 'names') {
    const { results } = await env.DB.prepare(`
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified, n.created_at, n.updated_at,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        )) FROM aliases a WHERE a.name_id = n.id) AS aliases,
        (SELECT json_group_array(json_object(
          'target_lang', v.target_lang,
          'target_text', v.target_text,
          'preferred', v.preferred,
          'verified', v.verified,
          'label', v.label,
          'notes', v.notes
        )) FROM name_output_variants v WHERE v.name_id = n.id) AS output_variants
      FROM names n
      ORDER BY n.id ASC
      LIMIT ?
    `).bind(MAX_EXPORT_ROWS).all();

    data = results.map(formatName);
    filename = 'names';

    if (format === 'csv') {
      const headers = ['id', 'mon', 'burmese', 'english', 'meaning', 'gender', 'verified', 'created_at', 'updated_at', 'aliases', 'output_variants'];
      const rows = data.map(r => [
        r.id, r.mon, r.burmese, r.english, r.meaning, r.gender,
        r.verified ? '1' : '0',
        r.created_at, r.updated_at,
        JSON.stringify(r.aliases),
        JSON.stringify(r.output_variants),
      ]);
      csvContent = toCSV(headers, rows);
    }

  } else if (type === 'suggestions') {
    const { results } = await env.DB.prepare(`
      SELECT id, mon, burmese, english, meaning, gender, aliases_json,
             submitted_by, status, admin_notes, approved_name_id, reviewed_at, created_at, updated_at
      FROM suggestions
      ORDER BY id ASC
      LIMIT ?
    `).bind(MAX_EXPORT_ROWS).all();

    data = results;
    filename = 'suggestions';

    if (format === 'csv') {
      const headers = ['id', 'mon', 'burmese', 'english', 'meaning', 'gender', 'aliases_json', 'submitted_by', 'status', 'admin_notes', 'approved_name_id', 'reviewed_at', 'created_at', 'updated_at'];
      const rows = data.map(r => [
        r.id, r.mon, r.burmese, r.english, r.meaning, r.gender, r.aliases_json,
        r.submitted_by, r.status, r.admin_notes, r.approved_name_id, r.reviewed_at, r.created_at, r.updated_at,
      ]);
      csvContent = toCSV(headers, rows);
    }

  } else {
    // segments
    const { results } = await env.DB.prepare(`
      SELECT
        s.id, s.source_text, s.source_lang, s.meaning, s.verified, s.created_at, s.updated_at,
        (SELECT json_group_array(json_object(
          'target_lang', v.target_lang,
          'target_text', v.target_text,
          'preferred', v.preferred,
          'verified', v.verified,
          'notes', v.notes
        )) FROM segment_variants v WHERE v.segment_id = s.id) AS variants
      FROM segments s
      ORDER BY s.id ASC
      LIMIT ?
    `).bind(MAX_EXPORT_ROWS).all();

    data = results.map(r => ({
      ...r,
      verified: !!r.verified,
      variants: (() => { try { return JSON.parse(r.variants || '[]'); } catch { return []; } })(),
    }));
    filename = 'segments';

    if (format === 'csv') {
      const headers = ['id', 'source_text', 'source_lang', 'meaning', 'verified', 'created_at', 'updated_at', 'variants'];
      const rows = data.map(r => [
        r.id, r.source_text, r.source_lang, r.meaning,
        r.verified ? '1' : '0',
        r.created_at, r.updated_at,
        JSON.stringify(r.variants),
      ]);
      csvContent = toCSV(headers, rows);
    }
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const ext = format === 'csv' ? 'csv' : 'json';
  const disposition = `attachment; filename="${filename}-${timestamp}.${ext}"`;

  if (format === 'json') {
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), count: data.length, data }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': disposition,
      },
    });
  }

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': disposition,
    },
  });
}

function normalize(q) {
  return (q || '').replace(/\s+/g, ' ').trim();
}

function escapeLike(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function isEnglishBoundaryChar(ch) {
  return !ch || /[\s\-_'"`.,/\\()[\]{}!?;:]/.test(ch);
}

function isEnglishWordStart(input, index) {
  if (index <= 0) return true;
  return isEnglishBoundaryChar(input[index - 1]);
}

function isEnglishWordEnd(input, index) {
  if (index >= input.length) return true;
  return isEnglishBoundaryChar(input[index]);
}

function englishMatchBonus(input, startIndex, sourceText) {
  const endIndex = startIndex + sourceText.length;
  const startsAtWord = isEnglishWordStart(input, startIndex);
  const endsAtWord = isEnglishWordEnd(input, endIndex);
  const isSingleChar = sourceText.length === 1;
  const isTiny = sourceText.length <= 2;

  let bonus = sourceText.length * 12;
  if (startsAtWord && endsAtWord) {
    bonus += 90;
  } else if (startsAtWord || endsAtWord) {
    bonus += 25;
  }

  if (sourceText.includes(' ')) bonus += 30;
  if (isTiny) bonus -= 12;
  if (isSingleChar) bonus -= 40;
  return bonus;
}

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

function shouldUseSecureCookie(request, env) {
  if (env?.FORCE_SECURE_COOKIES === 'true') return true;
  if (env?.FORCE_SECURE_COOKIES === 'false') return false;

  try {
    const url = new URL(request.url);
    if (url.protocol === 'https:') return true;
  } catch {}

  const xForwardedProto = request.headers.get('X-Forwarded-Proto');
  if (xForwardedProto && xForwardedProto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }

  return false;
}

function buildAdminSessionCookie(request, env, token, maxAge = 86400) {
  const attributes = [
    `admin_session=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/api/admin',
    `Max-Age=${maxAge}`,
  ];

  if (shouldUseSecureCookie(request, env)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

const ADMIN_LOGIN_LIMIT_MAX_FAILURES = 5;
const ADMIN_LOGIN_LIMIT_WINDOW_MINUTES = 15;

function getClientIp(request) {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();

  const xff = request.headers.get('X-Forwarded-For');
  if (!xff) return null;
  const firstHop = xff.split(',')[0]?.trim();
  return firstHop || null;
}

async function getLoginRateLimitState(env, ip) {
  const windowExpr = `-${ADMIN_LOGIN_LIMIT_WINDOW_MINUTES} minutes`;
  const state = await env.DB.prepare(
    `SELECT
      COUNT(*) AS failures_in_window,
      MIN(attempted_at) AS oldest_attempt_in_window
    FROM admin_login_failures
    WHERE ip = ?
      AND attempted_at >= datetime('now', ?)`
  ).bind(ip, windowExpr).first();

  const failuresInWindow = Number(state?.failures_in_window || 0);
  if (failuresInWindow < ADMIN_LOGIN_LIMIT_MAX_FAILURES) {
    return { limited: false };
  }

  let retryAfterSeconds = 0;
  if (state?.oldest_attempt_in_window) {
    const oldestMs = Date.parse(`${state.oldest_attempt_in_window}Z`);
    if (!Number.isNaN(oldestMs)) {
      const releaseMs = oldestMs + ADMIN_LOGIN_LIMIT_WINDOW_MINUTES * 60 * 1000;
      retryAfterSeconds = Math.max(1, Math.ceil((releaseMs - Date.now()) / 1000));
    }
  }

  return {
    limited: true,
    retryAfterSeconds,
  };
}

async function recordFailedLoginAttempt(env, ip) {
  await env.DB.prepare(
    `INSERT INTO admin_login_failures (ip) VALUES (?)`
  ).bind(ip).run();

  await env.DB.prepare(
    `DELETE FROM admin_login_failures
     WHERE ip = ?
       AND attempted_at < datetime('now', ?)`
  ).bind(ip, `-${ADMIN_LOGIN_LIMIT_WINDOW_MINUTES} minutes`).run();
}

async function clearFailedLoginAttempts(env, ip) {
  await env.DB.prepare(
    `DELETE FROM admin_login_failures WHERE ip = ?`
  ).bind(ip).run();
}

function isValidLang(lang) {
  return lang === 'mon' || lang === 'burmese' || lang === 'english';
}

function sourceColumn(lang) {
  return lang === 'mon' ? 'mon' : lang === 'burmese' ? 'burmese' : 'english';
}

function collapseSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const VALID_LANGUAGES = ['mon', 'burmese', 'english'];
const VALID_GENDERS = ['male', 'female', 'neutral'];
const SEGMENT_TEXT_LIMIT = 160;
const SEGMENT_MEANING_LIMIT = 300;
const SEGMENT_NOTES_LIMIT = 300;
const FIELD_LIMITS = {
  mon: 120,
  burmese: 120,
  english: 120,
  meaning: 300,
  alias: 120,
  variant_group: 80,
  usage_note: 200,
  output_variant_label: 80,
  output_variant_notes: 300,
  submitted_by: 80,
};

function sanitizeLimitedText(value, fieldName, errors, { maxLength, allowNull = true } = {}) {
  if (value === undefined || value === null) return allowNull ? null : '';
  if (typeof value !== 'string') {
    errors.push(`${fieldName} must be a string`);
    return null;
  }

  const normalized = collapseSpaces(value);
  if (!normalized) return null;

  if (maxLength && normalized.length > maxLength) {
    errors.push(`${fieldName} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function sanitizeAliasesInput(rawAliases, errors, { allowUndefined = true } = {}) {
  if (rawAliases === undefined) return allowUndefined ? undefined : [];
  if (rawAliases === null) return [];
  if (!Array.isArray(rawAliases)) {
    errors.push('aliases must be an array');
    return [];
  }

  const seen = new Set();
  const clean = [];

  for (let i = 0; i < rawAliases.length; i++) {
    const entry = rawAliases[i];
    if (!entry || typeof entry !== 'object') {
      errors.push(`aliases[${i}] must be an object with alias and language`);
      continue;
    }

    const alias = sanitizeLimitedText(entry.alias, `aliases[${i}].alias`, errors, {
      maxLength: FIELD_LIMITS.alias,
    });
    if (!alias) continue;

    const language = VALID_LANGUAGES.includes(entry.language) ? entry.language : 'english';
    const variant_group = sanitizeLimitedText(
      entry.variant_group,
      `aliases[${i}].variant_group`,
      errors,
      { maxLength: FIELD_LIMITS.variant_group }
    );
    const usage_note = sanitizeLimitedText(
      entry.usage_note,
      `aliases[${i}].usage_note`,
      errors,
      { maxLength: FIELD_LIMITS.usage_note }
    );
    const dedupeKey = `${language}||${alias.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    clean.push({
      alias,
      language,
      preferred: !!entry.preferred,
      variant_group,
      usage_note,
    });
  }

  return clean;
}

function sanitizeNamePayload(body, { includeSubmittedBy = false, aliasesOptional = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  const errors = [];
  const mon = sanitizeLimitedText(body.mon, 'mon', errors, { maxLength: FIELD_LIMITS.mon });
  const burmese = sanitizeLimitedText(body.burmese, 'burmese', errors, { maxLength: FIELD_LIMITS.burmese });
  const english = sanitizeLimitedText(body.english, 'english', errors, { maxLength: FIELD_LIMITS.english });
  const meaning = sanitizeLimitedText(body.meaning, 'meaning', errors, { maxLength: FIELD_LIMITS.meaning });
  const aliases = sanitizeAliasesInput(body.aliases, errors, { allowUndefined: aliasesOptional });
  const output_variants = sanitizeOutputVariantsInput(body.output_variants, errors, { allowUndefined: aliasesOptional });

  if (!mon && !burmese && !english) {
    errors.push('At least one of mon, burmese, or english is required');
  }

  const safeGender = VALID_GENDERS.includes(body.gender) ? body.gender : 'neutral';
  const payload = {
    mon,
    burmese,
    english,
    meaning,
    gender: safeGender,
    verified: !!body.verified,
    aliases,
    output_variants,
  };

  if (includeSubmittedBy) {
    payload.submitted_by = sanitizeLimitedText(body.submitted_by, 'submitted_by', errors, {
      maxLength: FIELD_LIMITS.submitted_by,
    });
  }

  return { errors, payload };
}

function sanitizeOutputVariantsInput(rawVariants, errors, { allowUndefined = true } = {}) {
  if (rawVariants === undefined) return allowUndefined ? undefined : [];
  if (rawVariants === null) return [];
  if (!Array.isArray(rawVariants)) {
    errors.push('output_variants must be an array');
    return [];
  }

  const seen = new Set();
  const clean = [];
  const preferredByLang = new Set();

  for (let i = 0; i < rawVariants.length; i++) {
    const entry = rawVariants[i];
    if (!entry || typeof entry !== 'object') {
      errors.push(`output_variants[${i}] must be an object`);
      continue;
    }

    const target_lang = VALID_LANGUAGES.includes(entry.target_lang) ? entry.target_lang : null;
    if (!target_lang) {
      errors.push(`output_variants[${i}].target_lang must be mon, burmese, or english`);
      continue;
    }

    const target_text = sanitizeLimitedText(entry.target_text, `output_variants[${i}].target_text`, errors, {
      maxLength: FIELD_LIMITS[target_lang],
      allowNull: false,
    });
    if (!target_text) continue;

    const label = sanitizeLimitedText(entry.label, `output_variants[${i}].label`, errors, {
      maxLength: FIELD_LIMITS.output_variant_label,
    });
    const notes = sanitizeLimitedText(entry.notes, `output_variants[${i}].notes`, errors, {
      maxLength: FIELD_LIMITS.output_variant_notes,
    });

    const dedupeKey = `${target_lang}||${target_text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const preferred = !!entry.preferred && !preferredByLang.has(target_lang);
    if (preferred) preferredByLang.add(target_lang);

    clean.push({
      target_lang,
      target_text,
      preferred,
      verified: entry.verified === undefined ? true : !!entry.verified,
      label,
      notes,
    });
  }

  const firstByLang = new Map();
  for (let i = 0; i < clean.length; i++) {
    const lang = clean[i].target_lang;
    if (!firstByLang.has(lang)) firstByLang.set(lang, i);
  }
  for (const [lang, index] of firstByLang.entries()) {
    if (clean.some(entry => entry.target_lang === lang && entry.preferred)) continue;
    clean[index].preferred = true;
  }

  return clean;
}

function sanitizeSegmentPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  const errors = [];
  const sourceText = sanitizeLimitedText(body.source_text, 'source_text', errors, {
    maxLength: SEGMENT_TEXT_LIMIT,
    allowNull: false,
  });
  const meaning = sanitizeLimitedText(body.meaning, 'meaning', errors, {
    maxLength: SEGMENT_MEANING_LIMIT,
  });
  const sourceLang = VALID_LANGUAGES.includes(body.source_lang) ? body.source_lang : null;
  if (!sourceLang) {
    errors.push('source_lang must be mon, burmese, or english');
  }

  return {
    errors,
    payload: {
      source_text: sourceText,
      source_lang: sourceLang,
      meaning,
      verified: !!body.verified,
    },
  };
}

function sanitizeSegmentVariantPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  const errors = [];
  const targetText = sanitizeLimitedText(body.target_text, 'target_text', errors, {
    maxLength: SEGMENT_TEXT_LIMIT,
    allowNull: false,
  });
  const notes = sanitizeLimitedText(body.notes, 'notes', errors, {
    maxLength: SEGMENT_NOTES_LIMIT,
  });
  const targetLang = VALID_LANGUAGES.includes(body.target_lang) ? body.target_lang : null;
  if (!targetLang) {
    errors.push('target_lang must be mon, burmese, or english');
  }

  return {
    errors,
    payload: {
      target_lang: targetLang,
      target_text: targetText,
      preferred: !!body.preferred,
      verified: !!body.verified,
      notes,
    },
  };
}

function toOptionFromName(row) {
  return {
    mon: row.mon,
    burmese: row.burmese,
    english: row.english,
    meaning: row.meaning,
    verified: !!row.verified,
    preferred: !!row.preferred,
  };
}

function toOptionWithTargetText(baseRow, toLang, variant = null, canonicalPreferred = false) {
  const option = {
    mon: baseRow.mon,
    burmese: baseRow.burmese,
    english: baseRow.english,
    meaning: baseRow.meaning,
    verified: variant ? !!variant.verified : !!baseRow.verified,
    preferred: variant ? !!variant.preferred : canonicalPreferred,
  };

  if (variant) {
    option[toLang] = variant.target_text;
    option.variantLabel = variant.label || null;
    option.variantNotes = variant.notes || null;
    option.outputVariantId = variant.id || null;
  }
  return option;
}

function buildNameOptionsForRow(row, toLang, variantsByNameId) {
  const variants = (variantsByNameId.get(row.id) || [])
    .filter(variant => variant.target_lang === toLang);
  const hasPreferredVariant = variants.some(variant => variant.preferred);

  const options = [
    toOptionWithTargetText(row, toLang, null, !hasPreferredVariant),
    ...variants.map(variant => toOptionWithTargetText(row, toLang, variant, false)),
  ];
  return dedupeOptions(options, toLang);
}

async function fetchNameOutputVariantsMap(env, nameIds, targetLang) {
  const uniqueIds = Array.from(new Set((nameIds || []).filter(Boolean)));
  const byNameId = new Map();
  if (uniqueIds.length === 0) return byNameId;

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(`
    SELECT id, name_id, target_lang, target_text, preferred, verified, label, notes
    FROM name_output_variants
    WHERE target_lang = ?
      AND name_id IN (${placeholders})
    ORDER BY preferred DESC, verified DESC, target_text ASC
  `).bind(targetLang, ...uniqueIds).all();

  for (const row of results || []) {
    if (!byNameId.has(row.name_id)) byNameId.set(row.name_id, []);
    byNameId.get(row.name_id).push({
      ...row,
      preferred: !!row.preferred,
      verified: !!row.verified,
    });
  }

  return byNameId;
}

function dedupeOptions(options, targetLang) {
  const ordered = [...options];

  ordered.sort((a, b) => {
    const aPreferred = a.preferred ? 1 : 0;
    const bPreferred = b.preferred ? 1 : 0;
    if (bPreferred !== aPreferred) return bPreferred - aPreferred;

    const aVerified = a.verified ? 1 : 0;
    const bVerified = b.verified ? 1 : 0;
    if (bVerified !== aVerified) return bVerified - aVerified;

    const at = collapseSpaces(a[targetLang] || '');
    const bt = collapseSpaces(b[targetLang] || '');
    return at.localeCompare(bt);
  });

  const seen = new Set();
  const deduped = [];
  for (const option of ordered) {
    const key = [
      collapseSpaces(option.mon),
      collapseSpaces(option.burmese),
      collapseSpaces(option.english),
      collapseSpaces(option.meaning),
    ].join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(option);
  }

  return deduped;
}

function buildAssembled(segments, toLang) {
  return segments
    .map(segment => {
      const choice = segment.options[segment.selectedIndex] || segment.options[0] || null;
      const text = choice ? (choice[toLang] || choice[segment.fromLang] || segment.source) : segment.source;
      return `${segment.separatorBefore}${text || ''}`;
    })
    .join('')
    .trim();
}

async function requireAdmin(request, env) {
  const token = getCookie(request, 'admin_session');
  if (!token) return err('Not authenticated', 401);

  const session = await env.DB.prepare(
    `SELECT token FROM admin_sessions
     WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();

  if (!session) return err('Invalid or expired session', 401);
  return null;
}

async function fetchExactNameMatches(env, input, fromLang) {
  const column = sourceColumn(fromLang);
  const { results } = await env.DB.prepare(
    `SELECT id, mon, burmese, english, meaning, verified
     FROM names
     WHERE ${column} = ?
     ORDER BY verified DESC, id ASC`
  ).bind(input).all();

  return results || [];
}

async function fetchExactAliasMatches(env, input, fromLang) {
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.mon, n.burmese, n.english, n.meaning, n.verified
     FROM aliases a
     JOIN names n ON n.id = a.name_id
     WHERE a.language = ? AND a.alias = ?
     ORDER BY n.verified DESC, n.id ASC`
  ).bind(fromLang, input).all();

  return results || [];
}

async function fetchPrefixGroups(env, remainder, fromLang, toLang) {
  const source = sourceColumn(fromLang);
  const normalizedRemainder = collapseSpaces(remainder);

  const [{ results: nameRows }, { results: aliasRows }, { results: segmentRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT ${source} AS source_text, mon, burmese, english, meaning, verified, 0 AS preferred
       FROM names
       WHERE ${source} IS NOT NULL
         AND substr(?, 1, length(${source})) = ${source}`
    ).bind(normalizedRemainder).all(),
    env.DB.prepare(
      `SELECT a.alias AS source_text, n.mon, n.burmese, n.english, n.meaning, n.verified, 0 AS preferred
       FROM aliases a
       JOIN names n ON n.id = a.name_id
       WHERE a.language = ?
         AND substr(?, 1, length(a.alias)) = a.alias`
    ).bind(fromLang, normalizedRemainder).all(),
    env.DB.prepare(
      `SELECT s.source_text,
              sv.target_text,
              s.meaning,
              s.verified,
              sv.preferred
       FROM segments s
       JOIN segment_variants sv ON sv.segment_id = s.id
       WHERE s.source_lang = ?
         AND sv.target_lang = ?
         AND substr(?, 1, length(s.source_text)) = s.source_text`
    ).bind(fromLang, toLang, normalizedRemainder).all(),
  ]);

  const grouped = new Map();

  const nameRowsNormalized = nameRows || [];
  const aliasRowsNormalized = aliasRows || [];
  const variantsByNameId = await fetchNameOutputVariantsMap(
    env,
    [...nameRowsNormalized, ...aliasRowsNormalized].map(row => row.id),
    toLang
  );

  for (const row of nameRowsNormalized) {
    const sourceText = collapseSpaces(row.source_text);
    if (!sourceText) continue;

    if (!grouped.has(sourceText)) grouped.set(sourceText, []);
    grouped.get(sourceText).push(...buildNameOptionsForRow(row, toLang, variantsByNameId));
  }

  for (const row of aliasRowsNormalized) {
    const sourceText = collapseSpaces(row.source_text);
    if (!sourceText) continue;

    if (!grouped.has(sourceText)) grouped.set(sourceText, []);
    grouped.get(sourceText).push(...buildNameOptionsForRow(row, toLang, variantsByNameId));
  }

  for (const row of segmentRows || []) {
    const sourceText = collapseSpaces(row.source_text);
    if (!sourceText) continue;

    if (!grouped.has(sourceText)) grouped.set(sourceText, []);
    grouped.get(sourceText).push({
      mon: fromLang === 'mon' ? sourceText : (toLang === 'mon' ? row.target_text : null),
      burmese: fromLang === 'burmese' ? sourceText : (toLang === 'burmese' ? row.target_text : null),
      english: fromLang === 'english' ? sourceText : (toLang === 'english' ? row.target_text : null),
      meaning: row.meaning,
      verified: !!row.verified,
      preferred: !!row.preferred,
      [toLang]: row.target_text,
    });
  }

  const groups = [];
  for (const [sourceText, options] of grouped.entries()) {
    groups.push({
      sourceText,
      options: dedupeOptions(options, toLang),
    });
  }

  groups.sort((a, b) => b.sourceText.length - a.sourceText.length || a.sourceText.localeCompare(b.sourceText));
  return groups;
}

function compareScore(a, b, isEnglish = false) {
  if (isEnglish) {
    if (a.matchedChars !== b.matchedChars) return a.matchedChars - b.matchedChars;
    if (a.englishQuality !== b.englishQuality) return a.englishQuality - b.englishQuality;
    if (a.verifiedSegments !== b.verifiedSegments) return a.verifiedSegments - b.verifiedSegments;
    if (a.unmatchedChars !== b.unmatchedChars) return b.unmatchedChars - a.unmatchedChars;
    if (a.singleCharSegments !== b.singleCharSegments) return b.singleCharSegments - a.singleCharSegments;
    if (a.tinySegments !== b.tinySegments) return b.tinySegments - a.tinySegments;
    if (a.matchedSegments !== b.matchedSegments) return b.matchedSegments - a.matchedSegments;
    return b.totalSegments - a.totalSegments;
  }

  if (a.matchedChars !== b.matchedChars) return a.matchedChars - b.matchedChars;
  if (a.matchedSegments !== b.matchedSegments) return a.matchedSegments - b.matchedSegments;
  if (a.verifiedSegments !== b.verifiedSegments) return a.verifiedSegments - b.verifiedSegments;
  return b.totalSegments - a.totalSegments;
}

async function findBestSegmentation(env, input, fromLang, toLang) {
  const cache = new Map();
  const isEnglish = fromLang === 'english';
  const emptyScore = {
    matchedChars: 0,
    matchedSegments: 0,
    verifiedSegments: 0,
    totalSegments: 0,
    englishQuality: 0,
    unmatchedChars: 0,
    singleCharSegments: 0,
    tinySegments: 0,
  };

  async function solve(position) {
    if (position >= input.length) {
      return { segments: [], score: { ...emptyScore } };
    }

    if (cache.has(position)) return cache.get(position);

    let scanPos = position;
    while (scanPos < input.length && /\s/.test(input[scanPos])) scanPos++;

    const separatorBefore = input.slice(position, scanPos);
    if (scanPos >= input.length) {
      const terminal = { segments: [], score: { ...emptyScore } };
      cache.set(position, terminal);
      return terminal;
    }

    const remainder = input.slice(scanPos);
    const prefixGroups = await fetchPrefixGroups(env, remainder, fromLang, toLang);

    let best = null;

    for (const group of prefixGroups) {
      const sourceText = group.sourceText;
      if (!remainder.startsWith(sourceText)) continue;

      const next = await solve(scanPos + sourceText.length);
      if (!next) continue;

      const verifiedInGroup = group.options.some(option => option.verified) ? 1 : 0;
      const currentSegment = {
        source: sourceText,
        fromLang,
        toLang,
        separatorBefore,
        matched: true,
        options: group.options,
        selectedIndex: 0,
      };

      const candidate = {
        segments: [currentSegment, ...next.segments],
        score: {
          matchedChars: next.score.matchedChars + sourceText.length,
          matchedSegments: next.score.matchedSegments + 1,
          verifiedSegments: next.score.verifiedSegments + verifiedInGroup,
          totalSegments: next.score.totalSegments + 1,
          englishQuality: next.score.englishQuality + (isEnglish ? englishMatchBonus(input, scanPos, sourceText) : 0),
          unmatchedChars: next.score.unmatchedChars,
          singleCharSegments: next.score.singleCharSegments + (isEnglish && sourceText.length === 1 ? 1 : 0),
          tinySegments: next.score.tinySegments + (isEnglish && sourceText.length <= 2 ? 1 : 0),
        },
      };

      if (!best || compareScore(candidate.score, best.score, isEnglish) > 0) {
        best = candidate;
      }
    }

    if (!best) {
      const next = await solve(scanPos + 1);
      if (next) {
        best = {
          segments: [{
            source: input[scanPos],
            fromLang,
            toLang,
            separatorBefore,
            matched: false,
            options: [{ [fromLang]: input[scanPos], [toLang]: input[scanPos], verified: false, preferred: true }],
            selectedIndex: 0,
          }, ...next.segments],
          score: {
            matchedChars: next.score.matchedChars,
            matchedSegments: next.score.matchedSegments,
            verifiedSegments: next.score.verifiedSegments,
            totalSegments: next.score.totalSegments + 1,
            englishQuality: next.score.englishQuality + (isEnglish ? -80 : 0),
            unmatchedChars: next.score.unmatchedChars + (isEnglish ? 1 : 0),
            singleCharSegments: next.score.singleCharSegments + (isEnglish ? 1 : 0),
            tinySegments: next.score.tinySegments + (isEnglish ? 1 : 0),
          },
        };
      }
    }

    cache.set(position, best);
    return best;
  }

  const solved = await solve(0);
  return solved ? solved.segments : [];
}

async function handleConvert(request, env) {
  const url = new URL(request.url);
  const input = normalize(url.searchParams.get('q'));
  const fromLang = url.searchParams.get('from') || 'burmese';
  const toLang = url.searchParams.get('to') || 'mon';

  if (!input) return json({ input: '', fromLang, toLang, mode: 'empty', segments: [], assembled: '' });
  if (!isValidLang(fromLang) || !isValidLang(toLang)) return err('Invalid language');
  if (fromLang === toLang) return err('Source and target languages must be different');

  const exactName = await fetchExactNameMatches(env, input, fromLang);
  if (exactName.length > 0) {
    const variantsByNameId = await fetchNameOutputVariantsMap(env, exactName.map(row => row.id), toLang);
    const segment = {
      source: input,
      fromLang,
      toLang,
      separatorBefore: '',
      matched: true,
      options: dedupeOptions(
        exactName.flatMap(row => buildNameOptionsForRow(row, toLang, variantsByNameId)),
        toLang
      ),
      selectedIndex: 0,
    };
    return json({
      input,
      fromLang,
      toLang,
      mode: 'exact_name',
      segments: [segment],
      assembled: buildAssembled([segment], toLang),
    });
  }

  const exactAlias = await fetchExactAliasMatches(env, input, fromLang);
  if (exactAlias.length > 0) {
    const variantsByNameId = await fetchNameOutputVariantsMap(env, exactAlias.map(row => row.id), toLang);
    const segment = {
      source: input,
      fromLang,
      toLang,
      separatorBefore: '',
      matched: true,
      options: dedupeOptions(
        exactAlias.flatMap(row => buildNameOptionsForRow(row, toLang, variantsByNameId)),
        toLang
      ),
      selectedIndex: 0,
    };
    return json({
      input,
      fromLang,
      toLang,
      mode: 'alias_name',
      segments: [segment],
      assembled: buildAssembled([segment], toLang),
    });
  }

  const segments = await findBestSegmentation(env, input, fromLang, toLang);
  const assembled = buildAssembled(segments, toLang);

  return json({
    input,
    fromLang,
    toLang,
    mode: 'segmented',
    segments,
    assembled,
  });
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = normalize(url.searchParams.get('q'));
  const lang = url.searchParams.get('lang') || 'all';

  if (!q) return json({ results: [] });
  if (q.length > 300) return err('Query too long (max 300 characters)');

  const safeQ = escapeLike(q);

  const exact = q;
  const prefix = `${safeQ}%`;
  const partial = `%${safeQ}%`;

  let sql;
  let bindings;

  if (lang === 'mon') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        ))
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.mon = ? THEN 0 WHEN n.mon LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.mon LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'mon' AND a.alias LIKE ? ESCAPE '\\')
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];
  } else if (lang === 'burmese') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        ))
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.burmese = ? THEN 0 WHEN n.burmese LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.burmese LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'burmese' AND a.alias LIKE ? ESCAPE '\\')
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];
  } else if (lang === 'english') {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        ))
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE WHEN n.english = ? THEN 0 WHEN n.english LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS match_rank
      FROM names n
      WHERE (
        n.english LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.language = 'english' AND a.alias LIKE ? ESCAPE '\\')
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, prefix, partial, partial];
  } else {
    sql = `
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        ))
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        CASE
          WHEN n.mon = ? OR n.burmese = ? OR n.english = ? THEN 0
          WHEN n.mon LIKE ? ESCAPE '\\' OR n.burmese LIKE ? ESCAPE '\\' OR n.english LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
        END AS match_rank
      FROM names n
      WHERE (
        n.mon LIKE ? ESCAPE '\\' OR n.burmese LIKE ? ESCAPE '\\' OR n.english LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM aliases a WHERE a.name_id = n.id AND a.alias LIKE ? ESCAPE '\\')
      )
      ORDER BY n.verified DESC, match_rank ASC, n.english ASC
      LIMIT 25`;
    bindings = [exact, exact, exact, prefix, prefix, prefix, partial, partial, partial, partial];
  }

  try {
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();
    return json({ results: results.map(formatName) });
  } catch (e) {
    console.error('Search error:', e);
    return err('Search failed', 500);
  }
}

async function handleSuggest(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeNamePayload(body, { includeSubmittedBy: true, aliasesOptional: true });
  if (errors.length) return invalidPayload(errors);

  const aliasesJson = Array.isArray(payload.aliases) && payload.aliases.length > 0
    ? JSON.stringify(payload.aliases)
    : null;

  try {
    await env.DB.prepare(`
      INSERT INTO suggestions (mon, burmese, english, meaning, gender, submitted_by, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      payload.mon, payload.burmese, payload.english,
      payload.meaning, payload.gender, payload.submitted_by, aliasesJson
    ).run();

    return json({ success: true, message: 'Thank you! Your suggestion has been submitted for review.' }, 201);
  } catch (e) {
    console.error('Suggest error:', e);
    return err('Failed to save suggestion', 500);
  }
}

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const clientIp = getClientIp(request);
  if (clientIp) {
    const rateLimit = await getLoginRateLimitState(env, clientIp);
    if (rateLimit.limited) {
      const payload = {
        error: 'Too many failed login attempts. Please try again shortly.',
      };
      if (rateLimit.retryAfterSeconds) {
        payload.retryAfterSeconds = rateLimit.retryAfterSeconds;
      }
      return json(payload, 429);
    }
  }

  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    if (clientIp) {
      await recordFailedLoginAttempt(env, clientIp);
    }
    return err('Invalid password', 401);
  }

  if (clientIp) {
    await clearFailedLoginAttempts(env, clientIp);
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
      'Set-Cookie': buildAdminSessionCookie(request, env, token),
    },
  });
}

async function handleLogout(request, env) {
  const token = getCookie(request, 'admin_session');
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildAdminSessionCookie(request, env, '', 0),
    },
  });
}

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

async function handleListNames(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const q = normalize(url.searchParams.get('q'));
  const limit = 50;
  const offset = (page - 1) * limit;
  const hasQuery = q.length > 0;

  if (q.length > 300) return err('Query too long (max 300 characters)');

  const partial = `%${escapeLike(q)}%`;
  const whereClause = hasQuery
    ? `WHERE (
      n.mon LIKE ? ESCAPE '\\'
      OR n.burmese LIKE ? ESCAPE '\\'
      OR n.english LIKE ? ESCAPE '\\'
      OR n.meaning LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM aliases a
        WHERE a.name_id = n.id
          AND a.alias LIKE ? ESCAPE '\\'
      )
    )`
    : '';

  const listBindings = hasQuery
    ? [partial, partial, partial, partial, partial, limit, offset]
    : [limit, offset];
  const countBindings = hasQuery ? [partial, partial, partial, partial, partial] : [];

  const [{ results }, countRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        n.id, n.mon, n.burmese, n.english, n.meaning, n.gender, n.verified, n.created_at,
        (SELECT json_group_array(json_object(
          'alias', a.alias,
          'language', a.language,
          'preferred', a.preferred,
          'variant_group', a.variant_group,
          'usage_note', a.usage_note
        ))
         FROM aliases a WHERE a.name_id = n.id) AS aliases,
        (SELECT json_group_array(json_object(
          'target_lang', v.target_lang,
          'target_text', v.target_text,
          'preferred', v.preferred,
          'verified', v.verified,
          'label', v.label,
          'notes', v.notes
        ))
         FROM name_output_variants v WHERE v.name_id = n.id) AS output_variants
      FROM names n
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...listBindings).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM names n
      ${whereClause}
    `).bind(...countBindings).first(),
  ]);

  return json({
    results: results.map(formatName),
    total: countRow.count,
    page,
    limit,
    totalPages: Math.ceil(countRow.count / limit),
    q,
  });
}

async function handleCreateName(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeNamePayload(body, { aliasesOptional: true });
  if (errors.length) return invalidPayload(errors);

  const result = await env.DB.prepare(`
    INSERT INTO names (mon, burmese, english, meaning, gender, verified)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    payload.mon, payload.burmese, payload.english,
    payload.meaning, payload.gender, payload.verified ? 1 : 0
  ).run();

  const nameId = result.meta.last_row_id;

  if (Array.isArray(payload.aliases) && payload.aliases.length > 0) {
    for (const { alias, language, preferred, variant_group, usage_note } of payload.aliases) {
      if (alias && VALID_LANGUAGES.includes(language)) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO aliases
           (name_id, alias, language, preferred, variant_group, usage_note)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          nameId,
          alias,
          language,
          preferred ? 1 : 0,
          variant_group,
          usage_note
        ).run();
      }
    }
  }

  if (Array.isArray(payload.output_variants) && payload.output_variants.length > 0) {
    for (const { target_lang, target_text, preferred, verified, label, notes } of payload.output_variants) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO name_output_variants
         (name_id, target_lang, target_text, preferred, verified, label, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        nameId,
        target_lang,
        target_text,
        preferred ? 1 : 0,
        verified ? 1 : 0,
        label,
        notes
      ).run();
    }
  }

  return json({ success: true, id: nameId }, 201);
}

async function handleUpdateName(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeNamePayload(body, { aliasesOptional: false });
  if (errors.length) return invalidPayload(errors);

  await env.DB.prepare(`
    UPDATE names
    SET mon = ?, burmese = ?, english = ?, meaning = ?,
        gender = ?, verified = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    payload.mon, payload.burmese, payload.english,
    payload.meaning, payload.gender, payload.verified ? 1 : 0, id
  ).run();

  if (payload.aliases !== undefined) {
    await env.DB.prepare('DELETE FROM aliases WHERE name_id = ?').bind(id).run();
    if (Array.isArray(payload.aliases)) {
      for (const { alias, language, preferred, variant_group, usage_note } of payload.aliases) {
        if (alias && VALID_LANGUAGES.includes(language)) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO aliases
             (name_id, alias, language, preferred, variant_group, usage_note)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            id,
            alias,
            language,
            preferred ? 1 : 0,
            variant_group,
            usage_note
          ).run();
        }
      }
    }
  }

  if (payload.output_variants !== undefined) {
    await env.DB.prepare('DELETE FROM name_output_variants WHERE name_id = ?').bind(id).run();
    if (Array.isArray(payload.output_variants)) {
      for (const { target_lang, target_text, preferred, verified, label, notes } of payload.output_variants) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO name_output_variants
           (name_id, target_lang, target_text, preferred, verified, label, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id,
          target_lang,
          target_text,
          preferred ? 1 : 0,
          verified ? 1 : 0,
          label,
          notes
        ).run();
      }
    }
  }

  return json({ success: true });
}

async function handleDeleteName(request, env, id) {
  await env.DB.prepare('DELETE FROM name_output_variants WHERE name_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM aliases WHERE name_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM names WHERE id = ?').bind(id).run();
  return json({ success: true });
}

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

async function handleUpdateSuggestion(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { status, admin_notes } = body;
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return err('status must be pending, approved, or rejected');
  }

  const suggestion = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
  if (!suggestion) return err('Suggestion not found', 404);

  // Idempotency guard: if we already approved and linked to a name,
  // do not promote the suggestion again.
  if (status === 'approved' && suggestion.status === 'approved' && suggestion.approved_name_id) {
    await env.DB.prepare(`
      UPDATE suggestions
      SET admin_notes = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).bind(admin_notes || null, id).run();

    return json({ success: true, alreadyApproved: true, nameId: suggestion.approved_name_id });
  }

  let approvedNameId = suggestion.approved_name_id || null;

  if (status === 'approved' && !approvedNameId) {
    const result = await env.DB.prepare(`
      INSERT INTO names (mon, burmese, english, meaning, gender, verified)
      VALUES (?, ?, ?, ?, ?, 1)
    `).bind(
      suggestion.mon,
      suggestion.burmese,
      suggestion.english,
      suggestion.meaning,
      suggestion.gender || 'neutral'
    ).run();

    approvedNameId = result.meta.last_row_id;

    if (suggestion.aliases_json) {
      let aliases;
      try { aliases = JSON.parse(suggestion.aliases_json); } catch { aliases = []; }
      const parseErrors = [];
      const cleanAliases = sanitizeAliasesInput(aliases, parseErrors, { allowUndefined: false });
      for (const { alias, language, preferred, variant_group, usage_note } of (cleanAliases || [])) {
        if (alias && VALID_LANGUAGES.includes(language)) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO aliases
             (name_id, alias, language, preferred, variant_group, usage_note)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            approvedNameId,
            alias,
            language,
            preferred ? 1 : 0,
            variant_group,
            usage_note
          ).run();
        }
      }
    }
  }

  await env.DB.prepare(`
    UPDATE suggestions
    SET status = ?,
        admin_notes = ?,
        approved_name_id = ?,
        reviewed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, admin_notes || null, status === 'approved' ? approvedNameId : null, id).run();

  return json({ success: true, nameId: status === 'approved' ? approvedNameId : null });
}

async function handleListSegments(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const q = normalize(url.searchParams.get('q'));
  const sourceLang = url.searchParams.get('source_lang') || 'all';
  const limit = 50;
  const offset = (page - 1) * limit;

  if (q.length > 300) return err('Query too long (max 300 characters)');
  if (sourceLang !== 'all' && !VALID_LANGUAGES.includes(sourceLang)) {
    return err('Invalid source_lang filter');
  }

  const hasQuery = q.length > 0;
  const safeQ = `%${escapeLike(q)}%`;
  const where = [];
  const bindings = [];

  if (sourceLang !== 'all') {
    where.push('s.source_lang = ?');
    bindings.push(sourceLang);
  }
  if (hasQuery) {
    where.push('s.source_text LIKE ? ESCAPE \'\\\'');
    bindings.push(safeQ);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const listBindings = [...bindings, limit, offset];
  const countBindings = [...bindings];

  const [{ results }, countRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        s.id,
        s.source_text,
        s.source_lang,
        s.meaning,
        s.verified,
        s.created_at,
        s.updated_at,
        COUNT(sv.id) AS variant_count
      FROM segments s
      LEFT JOIN segment_variants sv ON sv.segment_id = s.id
      ${whereClause}
      GROUP BY s.id
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).bind(...listBindings).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM segments s
      ${whereClause}
    `).bind(...countBindings).first(),
  ]);

  return json({
    results: (results || []).map(row => ({
      ...row,
      verified: !!row.verified,
      variant_count: Number(row.variant_count || 0),
    })),
    total: Number(countRow?.count || 0),
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(Number(countRow?.count || 0) / limit)),
    q,
    source_lang: sourceLang,
  });
}

async function handleCreateSegment(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeSegmentPayload(body);
  if (errors.length) return invalidPayload(errors);

  try {
    const result = await env.DB.prepare(`
      INSERT INTO segments (source_text, source_lang, meaning, verified)
      VALUES (?, ?, ?, ?)
    `).bind(
      payload.source_text,
      payload.source_lang,
      payload.meaning,
      payload.verified ? 1 : 0
    ).run();
    return json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('unique')) {
      return err('A segment with this source text and source language already exists', 409);
    }
    throw e;
  }
}

async function handleUpdateSegment(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeSegmentPayload(body);
  if (errors.length) return invalidPayload(errors);

  const existing = await env.DB.prepare('SELECT id FROM segments WHERE id = ?').bind(id).first();
  if (!existing) return err('Segment not found', 404);

  try {
    await env.DB.prepare(`
      UPDATE segments
      SET source_text = ?,
          source_lang = ?,
          meaning = ?,
          verified = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      payload.source_text,
      payload.source_lang,
      payload.meaning,
      payload.verified ? 1 : 0,
      id
    ).run();
    return json({ success: true });
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('unique')) {
      return err('A segment with this source text and source language already exists', 409);
    }
    throw e;
  }
}

async function handleDeleteSegment(request, env, id) {
  const existing = await env.DB.prepare('SELECT id FROM segments WHERE id = ?').bind(id).first();
  if (!existing) return err('Segment not found', 404);
  await env.DB.prepare('DELETE FROM segments WHERE id = ?').bind(id).run();
  return json({ success: true });
}

async function handleListSegmentVariants(request, env, segmentId) {
  const segment = await env.DB.prepare(`
    SELECT id, source_text, source_lang, meaning, verified
    FROM segments
    WHERE id = ?
  `).bind(segmentId).first();
  if (!segment) return err('Segment not found', 404);

  const { results } = await env.DB.prepare(`
    SELECT id, segment_id, target_lang, target_text, preferred, verified, notes, created_at
    FROM segment_variants
    WHERE segment_id = ?
    ORDER BY target_lang ASC, preferred DESC, verified DESC, target_text ASC
  `).bind(segmentId).all();

  return json({
    segment: { ...segment, verified: !!segment.verified },
    results: (results || []).map(row => ({
      ...row,
      preferred: !!row.preferred,
      verified: !!row.verified,
    })),
  });
}

async function applySegmentVariantPreferred(env, segmentId, targetLang, preferredId = null) {
  await env.DB.prepare(`
    UPDATE segment_variants
    SET preferred = CASE WHEN id = ? THEN 1 ELSE 0 END
    WHERE segment_id = ? AND target_lang = ?
  `).bind(preferredId || -1, segmentId, targetLang).run();
}

async function handleCreateSegmentVariant(request, env, segmentId) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeSegmentVariantPayload(body);
  if (errors.length) return invalidPayload(errors);

  const segment = await env.DB.prepare(`
    SELECT id, source_lang
    FROM segments
    WHERE id = ?
  `).bind(segmentId).first();
  if (!segment) return err('Segment not found', 404);
  if (payload.target_lang === segment.source_lang) {
    return err('target_lang must be different from source_lang');
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO segment_variants (segment_id, target_lang, target_text, preferred, verified, notes)
      VALUES (?, ?, ?, 0, ?, ?)
    `).bind(
      segmentId,
      payload.target_lang,
      payload.target_text,
      payload.verified ? 1 : 0,
      payload.notes
    ).run();

    if (payload.preferred) {
      await applySegmentVariantPreferred(env, segmentId, payload.target_lang, result.meta.last_row_id);
    }

    await env.DB.prepare(
      `UPDATE segments SET updated_at = datetime('now') WHERE id = ?`
    ).bind(segmentId).run();

    return json({ success: true, id: result.meta.last_row_id }, 201);
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('unique')) {
      return err('This target variant already exists for the segment', 409);
    }
    throw e;
  }
}

async function handleUpdateSegmentVariant(request, env, segmentId, variantId) {
  let body;
  try { body = await request.json(); }
  catch { return err('Request body must be valid JSON'); }

  const { errors, payload } = sanitizeSegmentVariantPayload(body);
  if (errors.length) return invalidPayload(errors);

  const segment = await env.DB.prepare(`
    SELECT id, source_lang
    FROM segments
    WHERE id = ?
  `).bind(segmentId).first();
  if (!segment) return err('Segment not found', 404);
  if (payload.target_lang === segment.source_lang) {
    return err('target_lang must be different from source_lang');
  }

  const existingVariant = await env.DB.prepare(`
    SELECT id
    FROM segment_variants
    WHERE id = ? AND segment_id = ?
  `).bind(variantId, segmentId).first();
  if (!existingVariant) return err('Variant not found', 404);

  try {
    await env.DB.prepare(`
      UPDATE segment_variants
      SET target_lang = ?,
          target_text = ?,
          verified = ?,
          notes = ?
      WHERE id = ? AND segment_id = ?
    `).bind(
      payload.target_lang,
      payload.target_text,
      payload.verified ? 1 : 0,
      payload.notes,
      variantId,
      segmentId
    ).run();

    if (payload.preferred) {
      await applySegmentVariantPreferred(env, segmentId, payload.target_lang, variantId);
    } else {
      await env.DB.prepare(`
        UPDATE segment_variants
        SET preferred = 0
        WHERE id = ? AND segment_id = ?
      `).bind(variantId, segmentId).run();
    }

    await env.DB.prepare(
      `UPDATE segments SET updated_at = datetime('now') WHERE id = ?`
    ).bind(segmentId).run();

    return json({ success: true });
  } catch (e) {
    if (String(e.message || '').toLowerCase().includes('unique')) {
      return err('This target variant already exists for the segment', 409);
    }
    throw e;
  }
}

async function handleDeleteSegmentVariant(request, env, segmentId, variantId) {
  const existingVariant = await env.DB.prepare(`
    SELECT id
    FROM segment_variants
    WHERE id = ? AND segment_id = ?
  `).bind(variantId, segmentId).first();
  if (!existingVariant) return err('Variant not found', 404);

  await env.DB.prepare(`
    DELETE FROM segment_variants
    WHERE id = ? AND segment_id = ?
  `).bind(variantId, segmentId).run();

  await env.DB.prepare(
    `UPDATE segments SET updated_at = datetime('now') WHERE id = ?`
  ).bind(segmentId).run();

  return json({ success: true });
}

async function router(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  if (method === 'GET' && pathname === '/api/search') return handleSearch(request, env);
  if (method === 'GET' && pathname === '/api/convert') return handleConvert(request, env);
  if (method === 'POST' && pathname === '/api/suggestions') return handleSuggest(request, env);

  if (method === 'POST' && pathname === '/api/admin/login') return handleLogin(request, env);
  if (method === 'POST' && pathname === '/api/admin/logout') return handleLogout(request, env);

  if (pathname.startsWith('/api/admin/')) {
    const authErr = await requireAdmin(request, env);
    if (authErr) return authErr;

    if (method === 'GET' && pathname === '/api/admin/stats') return handleAdminStats(request, env);
    if (method === 'GET' && pathname === '/api/admin/export') return handleAdminExport(request, env);
    if (method === 'GET' && pathname === '/api/admin/names') return handleListNames(request, env);
    if (method === 'POST' && pathname === '/api/admin/names') return handleCreateName(request, env);
    if (method === 'GET' && pathname === '/api/admin/segments') return handleListSegments(request, env);
    if (method === 'POST' && pathname === '/api/admin/segments') return handleCreateSegment(request, env);

    const nameMatch = pathname.match(/^\/api\/admin\/names\/(\d+)$/);
    if (nameMatch) {
      const id = parseInt(nameMatch[1], 10);
      if (method === 'PUT') return handleUpdateName(request, env, id);
      if (method === 'DELETE') return handleDeleteName(request, env, id);
    }

    const segmentMatch = pathname.match(/^\/api\/admin\/segments\/(\d+)$/);
    if (segmentMatch) {
      const id = parseInt(segmentMatch[1], 10);
      if (method === 'PUT') return handleUpdateSegment(request, env, id);
      if (method === 'DELETE') return handleDeleteSegment(request, env, id);
    }

    const segmentVariantsMatch = pathname.match(/^\/api\/admin\/segments\/(\d+)\/variants$/);
    if (segmentVariantsMatch) {
      const segmentId = parseInt(segmentVariantsMatch[1], 10);
      if (method === 'GET') return handleListSegmentVariants(request, env, segmentId);
      if (method === 'POST') return handleCreateSegmentVariant(request, env, segmentId);
    }

    const singleVariantMatch = pathname.match(/^\/api\/admin\/segments\/(\d+)\/variants\/(\d+)$/);
    if (singleVariantMatch) {
      const segmentId = parseInt(singleVariantMatch[1], 10);
      const variantId = parseInt(singleVariantMatch[2], 10);
      if (method === 'PUT') return handleUpdateSegmentVariant(request, env, segmentId, variantId);
      if (method === 'DELETE') return handleDeleteSegmentVariant(request, env, segmentId, variantId);
    }

    if (method === 'GET' && pathname === '/api/admin/suggestions') return handleListSuggestions(request, env);

    const suggMatch = pathname.match(/^\/api\/admin\/suggestions\/(\d+)$/);
    if (suggMatch) {
      const id = parseInt(suggMatch[1], 10);
      if (method === 'PUT') return handleUpdateSuggestion(request, env, id);
    }

    return err('Admin route not found', 404);
  }

  if (pathname.startsWith('/api/')) return err('Not found', 404);

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      const response = await router(request, env);
      return withCors(request, env, response);
    } catch (e) {
      console.error('Unhandled worker error:', e);
      return withCors(request, env, err('Internal server error', 500));
    }
  },
};
