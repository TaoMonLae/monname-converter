/**
 * Mon Names Converter — Admin Frontend
 * ======================================
 * Handles: login/logout, names CRUD, suggestion review.
 * Auth uses HttpOnly cookies set by the server — no token management in JS.
 * No framework — plain ES2020+.
 */

// ── Config ───────────────────────────────────────────────────
const API = '/api';

// ── State ────────────────────────────────────────────────────
let currentNamesPage = 1;
let currentNamesQuery = '';
let currentSuggestionStatus = 'pending';
let currentSegmentsPage = 1;
let currentSegmentsQuery = '';
let currentSegmentsSourceLang = 'all';
let allNames = [];           // local copy for client-side filter
let allSegments = [];
let editingAliases = [];     // aliases currently in the modal
let editingOutputVariants = [];
let currentSegmentVariants = [];

// ── DOM refs ─────────────────────────────────────────────────
const loginScreen     = document.getElementById('loginScreen');
const adminDashboard  = document.getElementById('adminDashboard');
const adminNav        = document.getElementById('adminNav');
const loginPassword   = document.getElementById('loginPassword');
const loginBtn        = document.getElementById('loginBtn');
const loginAlert      = document.getElementById('loginAlert');
const logoutBtn       = document.getElementById('logoutBtn');

const navItems        = document.querySelectorAll('.sidebar-nav__item');
const panelNames      = document.getElementById('panelNames');
const panelSuggestions = document.getElementById('panelSuggestions');
const panelSegments = document.getElementById('panelSegments');

const exportNamesBtn       = document.getElementById('exportNamesBtn');
const exportSuggestionsBtn = document.getElementById('exportSuggestionsBtn');
const exportSegmentsBtn    = document.getElementById('exportSegmentsBtn');
const exportNamesJsonBtn   = document.getElementById('exportNamesJsonBtn');
const exportSegmentsJsonBtn = document.getElementById('exportSegmentsJsonBtn');
const exportAllJsonBtn     = document.getElementById('exportAllJsonBtn');
const importJsonFile       = document.getElementById('importJsonFile');
const importModeSelect     = document.getElementById('importMode');
const importDryRunCheckbox = document.getElementById('importDryRun');
const importJsonBtn        = document.getElementById('importJsonBtn');
const importJsonResult     = document.getElementById('importJsonResult');
const createNameBtn   = document.getElementById('createNameBtn');
const nameModal       = document.getElementById('nameModal');
const nameModalTitle  = document.getElementById('nameModalTitle');
const nameModalClose  = document.getElementById('nameModalClose');
const nameModalCancel = document.getElementById('nameModalCancel');
const nameModalSave   = document.getElementById('nameModalSave');
const nameModalAlert  = document.getElementById('nameModalAlert');
const addAliasBtn     = document.getElementById('addAliasBtn');
const aliasRows       = document.getElementById('aliasRows');
const addOutputVariantBtn = document.getElementById('addOutputVariantBtn');
const outputVariantRows = document.getElementById('outputVariantRows');

const namesTableBody  = document.getElementById('namesTableBody');
const nameFilter      = document.getElementById('nameFilter');
const namesPagination = document.getElementById('namesPagination');
const createSegmentBtn = document.getElementById('createSegmentBtn');
const segmentFilter = document.getElementById('segmentFilter');
const segmentLangFilter = document.getElementById('segmentLangFilter');
const segmentsTableBody = document.getElementById('segmentsTableBody');
const segmentsPagination = document.getElementById('segmentsPagination');

const segmentModal = document.getElementById('segmentModal');
const segmentModalTitle = document.getElementById('segmentModalTitle');
const segmentModalClose = document.getElementById('segmentModalClose');
const segmentModalCancel = document.getElementById('segmentModalCancel');
const segmentModalSave = document.getElementById('segmentModalSave');
const segmentModalAlert = document.getElementById('segmentModalAlert');

const variantModal = document.getElementById('variantModal');
const variantModalTitle = document.getElementById('variantModalTitle');
const variantModalClose = document.getElementById('variantModalClose');
const variantModalCloseBtn = document.getElementById('variantModalCloseBtn');
const addVariantBtn = document.getElementById('addVariantBtn');
const variantsContainer = document.getElementById('variantsContainer');
const variantSegmentMeta = document.getElementById('variantSegmentMeta');
const variantModalAlert = document.getElementById('variantModalAlert');

const suggestionsContainer = document.getElementById('suggestionsContainer');
const suggTabs        = document.querySelectorAll('.tab-btn[data-status]');

const namesBadge      = document.getElementById('namesBadge');
const suggBadge       = document.getElementById('suggBadge');
const segmentsBadge   = document.getElementById('segmentsBadge');
const statTotal       = document.getElementById('statTotal');
const statVerified    = document.getElementById('statVerified');
const statPending     = document.getElementById('statPending');

// ═══════════════════════════════════════════════════════════
// ── Auth ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function showLoginScreen() {
  loginScreen.style.display = 'block';
  adminDashboard.style.display = 'none';
  adminNav.style.display = 'none';
}

function showDashboard() {
  loginScreen.style.display = 'none';
  adminDashboard.style.display = 'block';
  adminNav.style.display = 'flex';
}

loginBtn.addEventListener('click', doLogin);
loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const password = loginPassword.value;
  if (!password) return;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  hideAlert(loginAlert);

  try {
    const res = await fetch(`${API}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Login failed');

    // Server sets HttpOnly cookie — no token to store in JS
    loginPassword.value = '';
    showDashboard();
    initDashboard();
  } catch (e) {
    showAlert(loginAlert, e.message || 'Login failed', 'danger');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in →';
  }
}

logoutBtn.addEventListener('click', async () => {
  // Server clears the cookie via Set-Cookie: Max-Age=0
  await fetch(`${API}/admin/logout`, { method: 'POST' }).catch(() => {});
  showLoginScreen();
});

// ── Auth guard on page load ───────────────────────────────────
// Try a lightweight authenticated request; show dashboard if it succeeds,
// login screen if the cookie is absent or expired.
async function init() {
  try {
    await apiFetch(`${API}/admin/stats`);
    showDashboard();
    initDashboard();
  } catch {
    showLoginScreen();
  }
}

// ═══════════════════════════════════════════════════════════
// ── API Helper ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * Wrapper around fetch for admin API calls.
 * Cookies are sent automatically (same-origin). On 401 it redirects to login.
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    showLoginScreen();
    throw new Error('Session expired — please log in again');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ═══════════════════════════════════════════════════════════
// ── Navigation ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const panel = item.dataset.panel;
    panelNames.style.display       = panel === 'names'       ? 'block' : 'none';
    panelSuggestions.style.display = panel === 'suggestions' ? 'block' : 'none';
    panelSegments.style.display    = panel === 'segments'    ? 'block' : 'none';
    if (panel === 'suggestions') loadSuggestions(currentSuggestionStatus);
    if (panel === 'segments') loadSegments(currentSegmentsPage, currentSegmentsQuery, currentSegmentsSourceLang);
  });
});

// Suggestion status tabs
suggTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    suggTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentSuggestionStatus = tab.dataset.status;
    loadSuggestions(currentSuggestionStatus);
  });
});

// ═══════════════════════════════════════════════════════════
// ── Dashboard Init ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function initDashboard() {
  currentNamesQuery = nameFilter.value.trim();
  await Promise.all([
    loadStats(),
    loadNames(1, currentNamesQuery),
    loadSegments(1, currentSegmentsQuery, currentSegmentsSourceLang),
  ]);
}

// ═══════════════════════════════════════════════════════════
// ── Stats ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * Load accurate dashboard counts from the dedicated stats endpoint.
 * statVerified uses the server-side total, not a page-level count.
 */
async function loadStats() {
  try {
    const data = await apiFetch(`${API}/admin/stats`);
    statTotal.textContent   = data.total;
    statVerified.textContent = data.totalVerified;
    statPending.textContent = data.pendingSuggestions;
    namesBadge.textContent  = data.total;
    suggBadge.textContent   = data.pendingSuggestions;
  } catch { /* ignore — stat cards show stale values */ }
}

// ═══════════════════════════════════════════════════════════
// ── Names CRUD ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function loadNames(page = 1, query = currentNamesQuery) {
  currentNamesPage = page;
  currentNamesQuery = (query || '').trim();
  namesTableBody.innerHTML = `<tr><td colspan="7"><div class="spinner"></div></td></tr>`;

  try {
    const params = new URLSearchParams({ page: String(page) });
    if (currentNamesQuery) params.set('q', currentNamesQuery);
    const data = await apiFetch(`${API}/admin/names?${params.toString()}`);
    allNames = data.results;

    if (nameFilter.value !== currentNamesQuery) {
      nameFilter.value = currentNamesQuery;
    }
    namesBadge.textContent = data.total;
    renderNamesTable(data.results);
    renderPagination(data.page, data.totalPages);
  } catch (e) {
    namesTableBody.innerHTML = `<tr><td colspan="7"><div class="alert alert--danger">${escHtml(e.message)}</div></td></tr>`;
  }
}

let namesSearchDebounceTimer;
nameFilter.addEventListener('input', () => {
  clearTimeout(namesSearchDebounceTimer);
  const nextQuery = nameFilter.value.trim();
  namesSearchDebounceTimer = setTimeout(() => {
    loadNames(1, nextQuery);
  }, 250);
});

function renderNamesTable(names) {
  if (!names.length) {
    namesTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:var(--space-xl)">No entries found.</td></tr>`;
    return;
  }

  namesTableBody.innerHTML = names.map(name => `
    <tr>
      <td><span class="mon">${escHtml(name.mon || '—')}</span></td>
      <td><span class="bur">${escHtml(name.burmese || '—')}</span></td>
      <td><span class="eng">${escHtml(name.english || '—')}</span></td>
      <td class="truncate" style="max-width:160px; font-size:0.82rem; color:var(--text-muted)">${escHtml(name.meaning || '—')}</td>
      <td><span class="badge badge--${name.gender || 'neutral'}">${capitalize(name.gender || 'neutral')}</span></td>
      <td>
        ${name.verified
          ? '<span class="badge badge--verified">Verified</span>'
          : '<span class="badge badge--pending">Unverified</span>'}
      </td>
      <td>
        <div class="td-actions">
          <button class="btn btn--ghost btn--sm" onclick="openEditModal(${name.id})">Edit</button>
          <button class="btn btn--danger btn--sm" onclick="deleteName(${name.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderPagination(page, totalPages) {
  if (totalPages <= 1) { namesPagination.innerHTML = ''; return; }

  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(`<button class="pag-btn ${i === page ? 'active' : ''}" onclick="loadNames(${i})">${i}</button>`);
  }

  namesPagination.innerHTML = `
    <button class="pag-btn" onclick="loadNames(${page - 1})" ${page <= 1 ? 'disabled' : ''}>←</button>
    ${pages.join('')}
    <button class="pag-btn" onclick="loadNames(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>→</button>
  `;
}

// ── Delete ────────────────────────────────────────────────────
// Note: label is looked up from allNames rather than being passed via onclick,
// so apostrophes and other characters in names cannot break the inline JS.
async function deleteName(id) {
  const entry = allNames.find(n => n.id === id);
  const label = entry ? (entry.english || entry.mon || `Entry #${id}`) : `Entry #${id}`;
  if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
  try {
    await apiFetch(`${API}/admin/names/${id}`, { method: 'DELETE' });
    await Promise.all([loadNames(currentNamesPage), loadStats()]);
  } catch (e) {
    alert(`Failed to delete: ${e.message}`);
  }
}

// ── Modal: Open for create ────────────────────────────────────
createNameBtn.addEventListener('click', () => {
  document.getElementById('editNameId').value = '';
  nameModalTitle.textContent = 'New Name Entry';
  clearNameForm();
  openModal(nameModal);
});

// ── Modal: Open for edit ──────────────────────────────────────
async function openEditModal(id) {
  const name = allNames.find(n => n.id === id);
  if (!name) return;

  document.getElementById('editNameId').value = id;
  nameModalTitle.textContent = `Edit: ${name.english || name.mon || 'Entry #' + id}`;

  document.getElementById('f-mon').value      = name.mon     || '';
  document.getElementById('f-burmese').value  = name.burmese || '';
  document.getElementById('f-english').value  = name.english || '';
  document.getElementById('f-meaning').value  = name.meaning || '';
  document.getElementById('f-gender').value   = name.gender  || 'neutral';
  document.getElementById('f-verified').checked = !!name.verified;

  editingAliases = [...(name.aliases || [])];
  editingOutputVariants = [...(name.output_variants || [])];
  renderAliasRows();
  renderOutputVariantRows();
  hideAlert(nameModalAlert);
  openModal(nameModal);
}

// ── Modal: Save ───────────────────────────────────────────────
nameModalSave.addEventListener('click', async () => {
  const id       = document.getElementById('editNameId').value;
  const mon      = document.getElementById('f-mon').value.trim();
  const burmese  = document.getElementById('f-burmese').value.trim();
  const english  = document.getElementById('f-english').value.trim();
  const meaning  = document.getElementById('f-meaning').value.trim();
  const gender   = document.getElementById('f-gender').value;
  const verified = document.getElementById('f-verified').checked;

  if (!mon && !burmese && !english) {
    showAlert(nameModalAlert, 'At least one name field is required.', 'danger');
    return;
  }

  const aliases = collectAliases();
  const output_variants = collectOutputVariants();

  nameModalSave.disabled = true;
  nameModalSave.textContent = 'Saving…';

  try {
    const payload = { mon, burmese, english, meaning, gender, verified, aliases, output_variants };
    if (id) {
      await apiFetch(`${API}/admin/names/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch(`${API}/admin/names`, { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal(nameModal);
    await Promise.all([loadNames(currentNamesPage), loadStats()]);
  } catch (e) {
    showAlert(nameModalAlert, e.message || 'Save failed', 'danger');
  } finally {
    nameModalSave.disabled = false;
    nameModalSave.textContent = 'Save entry';
  }
});

nameModalClose.addEventListener('click',  () => closeModal(nameModal));
nameModalCancel.addEventListener('click', () => closeModal(nameModal));
nameModal.addEventListener('click', e => { if (e.target === nameModal) closeModal(nameModal); });

// ── Aliases ───────────────────────────────────────────────────

/**
 * Read current input values from the alias DOM rows back into editingAliases.
 * Must be called before any operation that re-renders the rows, so that text
 * typed without triggering onchange (no blur yet) is not lost.
 */
function syncAliasesFromDom() {
  aliasRows.querySelectorAll('.alias-row').forEach((row, i) => {
    if (editingAliases[i]) {
      editingAliases[i].alias = row.querySelector('[data-field="alias"]').value;
      editingAliases[i].language = row.querySelector('[data-field="language"]').value;
      editingAliases[i].preferred = row.querySelector('[data-field="preferred"]').checked;
      editingAliases[i].variant_group = row.querySelector('[data-field="variant_group"]').value;
      editingAliases[i].usage_note = row.querySelector('[data-field="usage_note"]').value;
    }
  });
}

addAliasBtn.addEventListener('click', () => {
  syncAliasesFromDom();
  editingAliases.push({
    alias: '',
    language: 'english',
    preferred: false,
    variant_group: '',
    usage_note: '',
  });
  renderAliasRows();
});

function renderAliasRows() {
  aliasRows.innerHTML = editingAliases.map((a, i) => `
    <div class="alias-row" data-index="${i}">
      <div class="alias-row__primary">
        <input
          type="text"
          data-field="alias"
          value="${escHtml(a.alias || '')}"
          placeholder="Alternate spelling"
          onchange="editingAliases[${i}].alias = this.value"
        />
        <select data-field="language" onchange="editingAliases[${i}].language = this.value">
          <option value="english"  ${a.language === 'english'  ? 'selected' : ''}>English</option>
          <option value="mon"      ${a.language === 'mon'      ? 'selected' : ''}>Mon</option>
          <option value="burmese"  ${a.language === 'burmese'  ? 'selected' : ''}>Burmese</option>
        </select>
        <label class="text-small" style="white-space:nowrap">
          <input
            type="checkbox"
            data-field="preferred"
            ${a.preferred ? 'checked' : ''}
            onchange="editingAliases[${i}].preferred = this.checked"
          />
          Preferred
        </label>
        <button class="btn btn--ghost btn--sm" onclick="removeAlias(${i})">✕</button>
      </div>
      <div class="alias-row__meta">
        <input
          type="text"
          data-field="variant_group"
          value="${escHtml(a.variant_group || '')}"
          placeholder="Variant family key (e.g. aung-family)"
          onchange="editingAliases[${i}].variant_group = this.value"
        />
        <input
          type="text"
          data-field="usage_note"
          value="${escHtml(a.usage_note || '')}"
          placeholder="Usage note (optional)"
          onchange="editingAliases[${i}].usage_note = this.value"
        />
      </div>
    </div>
  `).join('');
}

function removeAlias(index) {
  syncAliasesFromDom();
  editingAliases.splice(index, 1);
  renderAliasRows();
}

function collectAliases() {
  // Re-read from DOM to catch any unsaved typing
  return [...aliasRows.querySelectorAll('.alias-row')].map(row => ({
    alias: row.querySelector('[data-field="alias"]').value.trim(),
    language: row.querySelector('[data-field="language"]').value,
    preferred: row.querySelector('[data-field="preferred"]').checked,
    variant_group: row.querySelector('[data-field="variant_group"]').value.trim(),
    usage_note: row.querySelector('[data-field="usage_note"]').value.trim(),
  })).filter(a => a.alias);
}


function syncOutputVariantsFromDom() {
  outputVariantRows.querySelectorAll('.alias-row').forEach((row, i) => {
    if (!editingOutputVariants[i]) return;
    editingOutputVariants[i].target_lang = row.querySelector('[data-field="target_lang"]').value;
    editingOutputVariants[i].target_text = row.querySelector('[data-field="target_text"]').value;
    editingOutputVariants[i].preferred = row.querySelector('[data-field="preferred"]').checked;
    editingOutputVariants[i].verified = row.querySelector('[data-field="verified"]').checked;
    editingOutputVariants[i].label = row.querySelector('[data-field="label"]').value;
    editingOutputVariants[i].notes = row.querySelector('[data-field="notes"]').value;
  });
}

addOutputVariantBtn?.addEventListener('click', () => {
  syncOutputVariantsFromDom();
  editingOutputVariants.push({
    target_lang: 'english',
    target_text: '',
    preferred: false,
    verified: true,
    label: '',
    notes: '',
  });
  renderOutputVariantRows();
});

function renderOutputVariantRows() {
  if (!outputVariantRows) return;
  if (editingOutputVariants.length === 0) {
    outputVariantRows.innerHTML = '<p class="text-muted text-small">No output variants configured.</p>';
    return;
  }

  outputVariantRows.innerHTML = editingOutputVariants.map((variant, i) => `
    <div class="alias-row" data-index="${i}">
      <div class="alias-row__primary">
        <select data-field="target_lang" onchange="editingOutputVariants[${i}].target_lang = this.value">
          <option value="english" ${variant.target_lang === 'english' ? 'selected' : ''}>English</option>
          <option value="mon" ${variant.target_lang === 'mon' ? 'selected' : ''}>Mon</option>
          <option value="burmese" ${variant.target_lang === 'burmese' ? 'selected' : ''}>Burmese</option>
        </select>
        <input
          type="text"
          data-field="target_text"
          value="${escHtml(variant.target_text || '')}"
          placeholder="Output text"
          onchange="editingOutputVariants[${i}].target_text = this.value"
        />
        <label class="text-small" style="white-space:nowrap">
          <input type="checkbox" data-field="preferred" ${variant.preferred ? 'checked' : ''} onchange="editingOutputVariants[${i}].preferred = this.checked" />
          Preferred
        </label>
        <label class="text-small" style="white-space:nowrap">
          <input type="checkbox" data-field="verified" ${variant.verified ? 'checked' : ''} onchange="editingOutputVariants[${i}].verified = this.checked" />
          Verified
        </label>
        <button class="btn btn--ghost btn--sm" onclick="removeOutputVariant(${i})">✕</button>
      </div>
      <div class="alias-row__meta">
        <input
          type="text"
          data-field="label"
          value="${escHtml(variant.label || '')}"
          placeholder="Label (optional)"
          onchange="editingOutputVariants[${i}].label = this.value"
        />
        <input
          type="text"
          data-field="notes"
          value="${escHtml(variant.notes || '')}"
          placeholder="Notes (optional)"
          onchange="editingOutputVariants[${i}].notes = this.value"
        />
      </div>
    </div>
  `).join('');
}

function removeOutputVariant(index) {
  syncOutputVariantsFromDom();
  editingOutputVariants.splice(index, 1);
  renderOutputVariantRows();
}

function collectOutputVariants() {
  const rows = [...outputVariantRows.querySelectorAll('.alias-row')].map(row => ({
    target_lang: row.querySelector('[data-field="target_lang"]').value,
    target_text: row.querySelector('[data-field="target_text"]').value.trim(),
    preferred: row.querySelector('[data-field="preferred"]').checked,
    verified: row.querySelector('[data-field="verified"]').checked,
    label: row.querySelector('[data-field="label"]').value.trim(),
    notes: row.querySelector('[data-field="notes"]').value.trim(),
  })).filter(v => v.target_text);

  const preferredByLang = new Set();
  return rows.map((variant, index) => {
    const next = { ...variant };
    if (variant.preferred && preferredByLang.has(variant.target_lang)) {
      next.preferred = false;
    }
    if (next.preferred) preferredByLang.add(next.target_lang);
    if (!next.preferred && !preferredByLang.has(next.target_lang) && rows.findIndex(row => row.target_lang === next.target_lang) === index) {
      next.preferred = true;
      preferredByLang.add(next.target_lang);
    }
    return next;
  });
}

function clearNameForm() {
  document.getElementById('f-mon').value     = '';
  document.getElementById('f-burmese').value = '';
  document.getElementById('f-english').value = '';
  document.getElementById('f-meaning').value = '';
  document.getElementById('f-gender').value  = 'neutral';
  document.getElementById('f-verified').checked = false;
  editingAliases = [];
  editingOutputVariants = [];
  renderAliasRows();
  renderOutputVariantRows();
  hideAlert(nameModalAlert);
}

// ═══════════════════════════════════════════════════════════
// ── Segments CRUD + Variants ───────────────────────────────
// ═══════════════════════════════════════════════════════════

async function loadSegments(page = 1, query = currentSegmentsQuery, sourceLang = currentSegmentsSourceLang) {
  currentSegmentsPage = page;
  currentSegmentsQuery = (query || '').trim();
  currentSegmentsSourceLang = sourceLang || 'all';
  segmentsTableBody.innerHTML = `<tr><td colspan="6"><div class="spinner"></div></td></tr>`;

  try {
    const params = new URLSearchParams({ page: String(page) });
    if (currentSegmentsQuery) params.set('q', currentSegmentsQuery);
    if (currentSegmentsSourceLang && currentSegmentsSourceLang !== 'all') {
      params.set('source_lang', currentSegmentsSourceLang);
    }
    const data = await apiFetch(`${API}/admin/segments?${params.toString()}`);
    allSegments = data.results || [];
    if (segmentFilter.value !== currentSegmentsQuery) segmentFilter.value = currentSegmentsQuery;
    if (segmentLangFilter.value !== currentSegmentsSourceLang) segmentLangFilter.value = currentSegmentsSourceLang;
    segmentsBadge.textContent = data.total;
    renderSegmentsTable(allSegments);
    renderSegmentsPagination(data.page, data.totalPages);
  } catch (e) {
    segmentsTableBody.innerHTML = `<tr><td colspan="6"><div class="alert alert--danger">${escHtml(e.message)}</div></td></tr>`;
  }
}

let segmentsSearchDebounceTimer;
segmentFilter.addEventListener('input', () => {
  clearTimeout(segmentsSearchDebounceTimer);
  const nextQuery = segmentFilter.value.trim();
  segmentsSearchDebounceTimer = setTimeout(() => {
    loadSegments(1, nextQuery, segmentLangFilter.value);
  }, 250);
});

segmentLangFilter.addEventListener('change', () => {
  loadSegments(1, segmentFilter.value.trim(), segmentLangFilter.value);
});

function renderSegmentsTable(segments) {
  if (!segments.length) {
    segmentsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:var(--space-xl)">No segments found.</td></tr>`;
    return;
  }

  segmentsTableBody.innerHTML = segments.map(segment => `
    <tr>
      <td>${escHtml(segment.source_text)}</td>
      <td><span class="badge badge--neutral">${capitalize(segment.source_lang)}</span></td>
      <td class="truncate" style="max-width:220px; font-size:0.82rem; color:var(--text-muted)">${escHtml(segment.meaning || '—')}</td>
      <td>${segment.variant_count || 0}</td>
      <td>
        ${segment.verified
          ? '<span class="badge badge--verified">Verified</span>'
          : '<span class="badge badge--pending">Unverified</span>'}
      </td>
      <td>
        <div class="td-actions">
          <button class="btn btn--ghost btn--sm" onclick="openSegmentModal(${segment.id})">Edit</button>
          <button class="btn btn--ghost btn--sm" onclick="openVariantModal(${segment.id})">Variants</button>
          <button class="btn btn--danger btn--sm" onclick="deleteSegment(${segment.id})">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderSegmentsPagination(page, totalPages) {
  if (totalPages <= 1) { segmentsPagination.innerHTML = ''; return; }
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    pages.push(`<button class="pag-btn ${i === page ? 'active' : ''}" onclick="loadSegments(${i})">${i}</button>`);
  }
  segmentsPagination.innerHTML = `
    <button class="pag-btn" onclick="loadSegments(${page - 1})" ${page <= 1 ? 'disabled' : ''}>←</button>
    ${pages.join('')}
    <button class="pag-btn" onclick="loadSegments(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>→</button>
  `;
}

createSegmentBtn.addEventListener('click', () => {
  document.getElementById('editSegmentId').value = '';
  segmentModalTitle.textContent = 'New Segment';
  clearSegmentForm();
  openModal(segmentModal);
});

function openSegmentModal(id) {
  const segment = allSegments.find(s => s.id === id);
  if (!segment) return;
  document.getElementById('editSegmentId').value = id;
  segmentModalTitle.textContent = `Edit segment: ${segment.source_text}`;
  document.getElementById('seg-source-text').value = segment.source_text || '';
  document.getElementById('seg-source-lang').value = segment.source_lang || 'mon';
  document.getElementById('seg-meaning').value = segment.meaning || '';
  document.getElementById('seg-verified').checked = !!segment.verified;
  hideAlert(segmentModalAlert);
  openModal(segmentModal);
}

segmentModalSave.addEventListener('click', async () => {
  const id = document.getElementById('editSegmentId').value;
  const payload = {
    source_text: document.getElementById('seg-source-text').value.trim(),
    source_lang: document.getElementById('seg-source-lang').value,
    meaning: document.getElementById('seg-meaning').value.trim(),
    verified: document.getElementById('seg-verified').checked,
  };

  if (!payload.source_text) {
    showAlert(segmentModalAlert, 'Source text is required.', 'danger');
    return;
  }

  segmentModalSave.disabled = true;
  segmentModalSave.textContent = 'Saving…';
  try {
    if (id) {
      await apiFetch(`${API}/admin/segments/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await apiFetch(`${API}/admin/segments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    closeModal(segmentModal);
    await loadSegments(currentSegmentsPage, currentSegmentsQuery, currentSegmentsSourceLang);
  } catch (e) {
    showAlert(segmentModalAlert, e.message || 'Save failed', 'danger');
  } finally {
    segmentModalSave.disabled = false;
    segmentModalSave.textContent = 'Save segment';
  }
});

segmentModalClose.addEventListener('click', () => closeModal(segmentModal));
segmentModalCancel.addEventListener('click', () => closeModal(segmentModal));
segmentModal.addEventListener('click', e => { if (e.target === segmentModal) closeModal(segmentModal); });

async function deleteSegment(id) {
  const segment = allSegments.find(s => s.id === id);
  const label = segment ? `${segment.source_text} (${segment.source_lang})` : `Segment #${id}`;
  if (!confirm(`Delete ${label}? This also deletes all its variants.`)) return;
  try {
    await apiFetch(`${API}/admin/segments/${id}`, { method: 'DELETE' });
    await loadSegments(currentSegmentsPage, currentSegmentsQuery, currentSegmentsSourceLang);
  } catch (e) {
    alert(`Failed to delete segment: ${e.message}`);
  }
}

function clearSegmentForm() {
  document.getElementById('seg-source-text').value = '';
  document.getElementById('seg-source-lang').value = 'mon';
  document.getElementById('seg-meaning').value = '';
  document.getElementById('seg-verified').checked = false;
  hideAlert(segmentModalAlert);
}

async function openVariantModal(segmentId) {
  const segment = allSegments.find(s => s.id === segmentId);
  if (!segment) return;
  document.getElementById('variantSegmentId').value = segmentId;
  variantModalTitle.textContent = `Variants: ${segment.source_text}`;
  variantSegmentMeta.textContent = `Source language: ${capitalize(segment.source_lang)} • Segment status: ${segment.verified ? 'Verified' : 'Unverified'}`;
  hideAlert(variantModalAlert);
  openModal(variantModal);
  await loadSegmentVariants(segmentId);
}

async function loadSegmentVariants(segmentId) {
  variantsContainer.innerHTML = '<div class="spinner"></div>';
  try {
    const data = await apiFetch(`${API}/admin/segments/${segmentId}/variants`);
    currentSegmentVariants = data.results || [];
    renderVariantRows(data.segment, currentSegmentVariants);
  } catch (e) {
    variantsContainer.innerHTML = `<div class="alert alert--danger">${escHtml(e.message)}</div>`;
  }
}

function renderVariantRows(segment, variants) {
  if (!variants.length) {
    variantsContainer.innerHTML = '<p class="text-muted">No variants yet. Add one.</p>';
    return;
  }

  variantsContainer.innerHTML = variants.map(variant => `
    <div class="sugg-card" style="padding:var(--space-md); margin-bottom:var(--space-sm)">
      <div class="sugg-card__body">
        <div style="display:grid; grid-template-columns:140px 1fr; gap:var(--space-sm); align-items:center">
          <div>
            <label class="text-small text-muted">Target language</label>
            <select onchange="editVariantField(${variant.id}, 'target_lang', this.value)">
              <option value="mon" ${variant.target_lang === 'mon' ? 'selected' : ''} ${segment.source_lang === 'mon' ? 'disabled' : ''}>Mon</option>
              <option value="burmese" ${variant.target_lang === 'burmese' ? 'selected' : ''} ${segment.source_lang === 'burmese' ? 'disabled' : ''}>Burmese</option>
              <option value="english" ${variant.target_lang === 'english' ? 'selected' : ''} ${segment.source_lang === 'english' ? 'disabled' : ''}>English</option>
            </select>
          </div>
          <div>
            <label class="text-small text-muted">Target text</label>
            <input type="text" value="${escHtml(variant.target_text)}" onchange="editVariantField(${variant.id}, 'target_text', this.value)" />
          </div>
          <div style="grid-column:1 / -1">
            <label class="text-small text-muted">Notes</label>
            <input type="text" value="${escHtml(variant.notes || '')}" onchange="editVariantField(${variant.id}, 'notes', this.value)" />
          </div>
        </div>
        <div style="margin-top:var(--space-sm); display:flex; gap:var(--space-sm); align-items:center; flex-wrap:wrap;">
          <label><input type="checkbox" ${variant.verified ? 'checked' : ''} onchange="editVariantField(${variant.id}, 'verified', this.checked)" /> Verified</label>
          <label><input type="checkbox" ${variant.preferred ? 'checked' : ''} onchange="editVariantField(${variant.id}, 'preferred', this.checked)" /> Preferred for ${variant.target_lang}</label>
          <button class="btn btn--primary btn--sm" onclick="saveVariant(${segment.id}, ${variant.id})">Save</button>
          <button class="btn btn--danger btn--sm" onclick="deleteVariant(${segment.id}, ${variant.id})">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

addVariantBtn.addEventListener('click', () => {
  const segmentId = Number(document.getElementById('variantSegmentId').value);
  if (!segmentId) return;
  const segment = allSegments.find(s => s.id === segmentId);
  const defaultLang = ['english', 'mon', 'burmese'].find(lang => lang !== segment?.source_lang) || 'english';
  const rowId = `new-${Date.now()}`;
  currentSegmentVariants.unshift({
    id: rowId,
    segment_id: segmentId,
    target_lang: defaultLang,
    target_text: '',
    preferred: false,
    verified: false,
    notes: '',
    isNew: true,
  });
  renderVariantRows(segment, currentSegmentVariants);
});

function editVariantField(variantId, field, value) {
  const idx = currentSegmentVariants.findIndex(v => String(v.id) === String(variantId));
  if (idx === -1) return;
  currentSegmentVariants[idx][field] = value;
}

async function saveVariant(segmentId, variantId) {
  const variant = currentSegmentVariants.find(v => String(v.id) === String(variantId));
  if (!variant) return;
  if (!variant.target_text || !variant.target_text.trim()) {
    showAlert(variantModalAlert, 'Target text is required for variants.', 'danger');
    return;
  }

  const payload = {
    target_lang: variant.target_lang,
    target_text: variant.target_text.trim(),
    preferred: !!variant.preferred,
    verified: !!variant.verified,
    notes: (variant.notes || '').trim(),
  };

  try {
    if (variant.isNew) {
      await apiFetch(`${API}/admin/segments/${segmentId}/variants`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } else {
      await apiFetch(`${API}/admin/segments/${segmentId}/variants/${variant.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    }
    hideAlert(variantModalAlert);
    await loadSegmentVariants(segmentId);
    await loadSegments(currentSegmentsPage, currentSegmentsQuery, currentSegmentsSourceLang);
  } catch (e) {
    showAlert(variantModalAlert, e.message || 'Failed to save variant', 'danger');
  }
}

async function deleteVariant(segmentId, variantId) {
  const variant = currentSegmentVariants.find(v => String(v.id) === String(variantId));
  if (!variant) return;

  if (variant.isNew) {
    currentSegmentVariants = currentSegmentVariants.filter(v => String(v.id) !== String(variantId));
    const segment = allSegments.find(s => s.id === segmentId);
    renderVariantRows(segment, currentSegmentVariants);
    return;
  }

  if (!confirm('Delete this variant?')) return;
  try {
    await apiFetch(`${API}/admin/segments/${segmentId}/variants/${variantId}`, { method: 'DELETE' });
    await loadSegmentVariants(segmentId);
    await loadSegments(currentSegmentsPage, currentSegmentsQuery, currentSegmentsSourceLang);
  } catch (e) {
    showAlert(variantModalAlert, e.message || 'Failed to delete variant', 'danger');
  }
}

variantModalClose.addEventListener('click', () => closeModal(variantModal));
variantModalCloseBtn.addEventListener('click', () => closeModal(variantModal));
variantModal.addEventListener('click', e => { if (e.target === variantModal) closeModal(variantModal); });

// ═══════════════════════════════════════════════════════════
// ── Suggestions ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function loadSuggestions(status = 'pending') {
  currentSuggestionStatus = status;
  suggestionsContainer.innerHTML = '<div class="spinner"></div>';

  try {
    const data = await apiFetch(`${API}/admin/suggestions?status=${status}`);
    renderSuggestions(data.results, status);
  } catch (e) {
    suggestionsContainer.innerHTML = `<div class="alert alert--danger">${escHtml(e.message)}</div>`;
  }
}

function renderSuggestions(results, status) {
  if (!results.length) {
    suggestionsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">${status === 'pending' ? '📭' : '✓'}</div>
        <div class="empty-state__title">No ${status} suggestions</div>
        <p class="empty-state__text">
          ${status === 'pending'
            ? 'No suggestions awaiting review right now.'
            : `No ${status} suggestions to show.`}
        </p>
      </div>`;
    return;
  }

  suggestionsContainer.innerHTML = results.map(s => {
    // Parse aliases_json if present
    let aliasesHtml = '';
    if (s.aliases_json) {
      try {
        const aliases = JSON.parse(s.aliases_json);
        if (aliases.length) {
          aliasesHtml = `<div style="margin-top:var(--space-xs); display:flex; gap:var(--space-xs); flex-wrap:wrap;">
            ${aliases.map(a => `<span class="alias-pill" title="${escHtml(a.language)}">${escHtml(a.alias)}</span>`).join('')}
          </div>`;
        }
      } catch { /* ignore malformed JSON */ }
    }

    return `
    <div class="sugg-card" id="sugg-${s.id}">
      <div class="sugg-card__body">
        <div class="sugg-card__names">
          ${s.mon     ? `<div class="sugg-card__field"><span class="sugg-card__field-label">Mon</span><span class="sugg-card__field-val mon">${escHtml(s.mon)}</span></div>` : ''}
          ${s.burmese ? `<div class="sugg-card__field"><span class="sugg-card__field-label">Burmese</span><span class="sugg-card__field-val bur">${escHtml(s.burmese)}</span></div>` : ''}
          ${s.english ? `<div class="sugg-card__field"><span class="sugg-card__field-label">English</span><span class="sugg-card__field-val eng">${escHtml(s.english)}</span></div>` : ''}
        </div>
        ${aliasesHtml}
        ${s.meaning ? `<p class="text-small text-muted" style="margin-top:var(--space-sm)">Notes / Meaning: ${escHtml(s.meaning)}</p>` : ''}
        <div style="display:flex; gap:var(--space-sm); flex-wrap:wrap; margin-top:var(--space-sm)">
          <span class="badge badge--${s.gender || 'neutral'}">${capitalize(s.gender || 'neutral')}</span>
          <span class="badge badge--${s.status}">${capitalize(s.status)}</span>
          ${s.submitted_by ? `<span class="text-small text-muted">from: ${escHtml(s.submitted_by)}</span>` : ''}
          <span class="text-small text-muted">${formatDate(s.created_at)}</span>
        </div>
        ${s.admin_notes ? `<p class="text-small mt-sm" style="color:var(--warning)">Note: ${escHtml(s.admin_notes)}</p>` : ''}
      </div>
      ${status === 'pending' ? `
        <div class="sugg-card__actions">
          <button class="btn btn--accent btn--sm" onclick="reviewSuggestion(${s.id}, 'approved')">✓ Approve</button>
          <button class="btn btn--ghost btn--sm" onclick="promptReject(${s.id})">✗ Reject</button>
        </div>` : ''}
    </div>`;
  }).join('');
}

async function reviewSuggestion(id, status, admin_notes = null) {
  try {
    await apiFetch(`${API}/admin/suggestions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status, admin_notes }),
    });

    // Animate card out
    const card = document.getElementById(`sugg-${id}`);
    if (card) {
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      card.style.transition = 'all 0.3s ease';
      setTimeout(() => card.remove(), 300);
    }

    // Refresh stats (suggestion count and, if approved, name count)
    await loadStats();
    if (status === 'approved') {
      await loadNames(currentNamesPage);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

function promptReject(id) {
  const notes = prompt('Rejection note (optional — stored for reference):');
  if (notes === null) return; // User cancelled
  reviewSuggestion(id, 'rejected', notes || null);
}

// ═══════════════════════════════════════════════════════════
// ── Modal helpers ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function openModal(el) {
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(el) {
  el.classList.remove('open');
  document.body.style.overflow = '';
}

// Close modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(closeModal);
  }
});

// ═══════════════════════════════════════════════════════════
// ── Alert helpers ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function showAlert(el, msg, type = 'danger') {
  el.className = `alert alert--${type}`;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideAlert(el) {
  el.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// ── Utilities ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return dateStr; }
}

// ── Expose functions called from inline onclick attrs ────────
window.openEditModal    = openEditModal;
window.deleteName       = deleteName;
window.removeAlias      = removeAlias;
window.reviewSuggestion = reviewSuggestion;
window.promptReject     = promptReject;
window.loadNames        = loadNames;
window.loadSegments     = loadSegments;
window.openSegmentModal = openSegmentModal;
window.deleteSegment    = deleteSegment;
window.openVariantModal = openVariantModal;
window.editVariantField = editVariantField;
window.saveVariant      = saveVariant;
window.deleteVariant    = deleteVariant;

// ═══════════════════════════════════════════════════════════
// ── Export ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function triggerExport(type, format = 'csv') {
  const btn = { names: exportNamesBtn, suggestions: exportSuggestionsBtn, segments: exportSegmentsBtn }[type];
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }

  try {
    const res = await fetch(`${API}/admin/export?type=${type}&format=${format}`, { credentials: 'same-origin' });
    if (res.status === 401) { showLoginScreen(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `${type}-export.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`Export failed: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

exportNamesBtn.addEventListener('click', () => triggerExport('names'));
exportSuggestionsBtn.addEventListener('click', () => triggerExport('suggestions'));
exportSegmentsBtn.addEventListener('click', () => triggerExport('segments'));

async function triggerJsonExport(scope, btn) {
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    const res = await fetch(`${API}/admin/export/json?scope=${encodeURIComponent(scope)}`, {
      credentials: 'same-origin',
    });
    if (res.status === 401) { showLoginScreen(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `export-${scope}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert(`JSON export failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderImportSummary(data) {
  if (!importJsonResult) return;
  importJsonResult.style.display = 'block';
  importJsonResult.textContent = JSON.stringify(data, null, 2);
}

async function triggerJsonImport() {
  if (!importJsonBtn || !importJsonFile) return;
  const file = importJsonFile.files && importJsonFile.files[0];
  if (!file) {
    alert('Please choose a JSON file to import.');
    return;
  }

  const original = importJsonBtn.textContent;
  importJsonBtn.disabled = true;
  importJsonBtn.textContent = 'Importing…';
  if (importJsonResult) importJsonResult.style.display = 'none';

  try {
    const rawText = await file.text();
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error('Selected file is not valid JSON');
    }

    const res = await fetch(`${API}/admin/import/json`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: importModeSelect ? importModeSelect.value : 'merge',
        dryRun: importDryRunCheckbox ? !!importDryRunCheckbox.checked : true,
        payload,
      }),
    });

    if (res.status === 401) { showLoginScreen(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderImportSummary(data);
  } catch (e) {
    renderImportSummary({ success: false, error: e.message });
  } finally {
    importJsonBtn.disabled = false;
    importJsonBtn.textContent = original;
  }
}

exportNamesJsonBtn?.addEventListener('click', () => triggerJsonExport('names', exportNamesJsonBtn));
exportSegmentsJsonBtn?.addEventListener('click', () => triggerJsonExport('segments', exportSegmentsJsonBtn));
exportAllJsonBtn?.addEventListener('click', () => triggerJsonExport('all', exportAllJsonBtn));
importJsonBtn?.addEventListener('click', triggerJsonImport);

// ── Night mode toggle ─────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);

  function applyToBtn(btn, theme) {
    if (!btn) return;
    btn.textContent = theme === 'dark' ? '☀ Light' : '🌙 Dark';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  const btns = [
    document.getElementById('themeToggle'),
    document.getElementById('themeToggleLogin'),
  ];
  btns.forEach(b => applyToBtn(b, saved));

  btns.forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      btns.forEach(b => applyToBtn(b, next));
    });
  });
})();

// ── Start ─────────────────────────────────────────────────────
init();
