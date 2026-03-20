const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const err = (message, status = 400) => json({ error: message }, status);

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function parseAliases(raw) {
  if (!raw) return [];
  return raw.split('||').map(part => {
    const [alias, language] = part.split('~~');
    return { alias, language };
  });
}

function formatName(row) {
  return { ...row, verified: !!row.verified, aliases: parseAliases(row.aliases) };
}

function normalize(q) {
  return (q || '').replace(/\s+/g, ' ').trim();
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

function sessionCookie(token, maxAge = 86400) {
  return `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAge}`;
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

function dedupeOptions(options, targetLang) {
  const seen = new Set();
  const ordered = [];

  for (const option of options) {
    const key = [
      collapseSpaces(option.mon),
      collapseSpaces(option.burmese),
      collapseSpaces(option.english),
      collapseSpaces(option.meaning),
      option.verified ? '1' : '0',
      option.preferred ? '1' : '0',
    ].join('||');

    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(option);
  }

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

  return ordered;
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

  for (const row of nameRows || []) {
    const sourceText = collapseSpaces(row.source_text);
    if (!sourceText) continue;

    if (!grouped.has(sourceText)) grouped.set(sourceText, []);
    grouped.get(sourceText).push(toOptionFromName(row));
  }

  for (const row of aliasRows || []) {
    const sourceText = collapseSpaces(row.source_text);
    if (!sourceText) continue;

    if (!grouped.has(sourceText)) grouped.set(sourceText, []);
    grouped.get(sourceText).push(toOptionFromName(row));
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
    const segment = {
      source: input,
      fromLang,
      toLang,
      separatorBefore: '',
      matched: true,
      options: dedupeOptions(exactName.map(toOptionFromName), toLang),
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
    const segment = {
      source: input,
      fromLang,
      toLang,
      separatorBefore: '',
      matched: true,
      options: dedupeOptions(exactAlias.map(toOptionFromName), toLang),
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

  // Escape SQLite LIKE special characters to prevent unexpected wildcard behaviour
  function escapeLike(s) {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }
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
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
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
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
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
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
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
        (SELECT GROUP_CONCAT(a.alias || '~~' || a.language, '||')
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

  const { mon, burmese, english, meaning, gender, submitted_by, aliases } = body;

  if (!mon && !burmese && !english) {
    return err('At least one name field (Mon, Burmese, or English) is required');
  }

  const validGenders = ['male', 'female', 'neutral'];
  const safeGender = validGenders.includes(gender) ? gender : 'neutral';

  let aliasesJson = null;
  if (Array.isArray(aliases) && aliases.length > 0) {
    const validLangs = ['mon', 'burmese', 'english'];
    const clean = aliases
      .filter(a => a && typeof a.alias === 'string' && a.alias.trim())
      .map(a => ({ alias: a.alias.trim(), language: validLangs.includes(a.language) ? a.language : 'english' }));

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

async function handleLogout(request, env) {
  const token = getCookie(request, 'admin_session');
  if (token) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie('', 0),
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

async function handleDeleteName(request, env, id) {
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
    if (method === 'GET' && pathname === '/api/admin/names') return handleListNames(request, env);
    if (method === 'POST' && pathname === '/api/admin/names') return handleCreateName(request, env);

    const nameMatch = pathname.match(/^\/api\/admin\/names\/(\d+)$/);
    if (nameMatch) {
      const id = parseInt(nameMatch[1], 10);
      if (method === 'PUT') return handleUpdateName(request, env, id);
      if (method === 'DELETE') return handleDeleteName(request, env, id);
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
      return withCors(response);
    } catch (e) {
      console.error('Unhandled worker error:', e);
      return withCors(err('Internal server error', 500));
    }
  },
};
