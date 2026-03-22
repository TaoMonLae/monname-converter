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
let allNames = [];           // local copy for client-side filter
let editingAliases = [];     // aliases currently in the modal

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

const createNameBtn   = document.getElementById('createNameBtn');
const nameModal       = document.getElementById('nameModal');
const nameModalTitle  = document.getElementById('nameModalTitle');
const nameModalClose  = document.getElementById('nameModalClose');
const nameModalCancel = document.getElementById('nameModalCancel');
const nameModalSave   = document.getElementById('nameModalSave');
const nameModalAlert  = document.getElementById('nameModalAlert');
const addAliasBtn     = document.getElementById('addAliasBtn');
const aliasRows       = document.getElementById('aliasRows');

const namesTableBody  = document.getElementById('namesTableBody');
const nameFilter      = document.getElementById('nameFilter');
const namesPagination = document.getElementById('namesPagination');

const suggestionsContainer = document.getElementById('suggestionsContainer');
const suggTabs        = document.querySelectorAll('.tab-btn[data-status]');

const namesBadge      = document.getElementById('namesBadge');
const suggBadge       = document.getElementById('suggBadge');
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
    if (panel === 'suggestions') loadSuggestions(currentSuggestionStatus);
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
  renderAliasRows();
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

  nameModalSave.disabled = true;
  nameModalSave.textContent = 'Saving…';

  try {
    const payload = { mon, burmese, english, meaning, gender, verified, aliases };
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
      editingAliases[i].alias    = row.querySelector('input').value;
      editingAliases[i].language = row.querySelector('select').value;
    }
  });
}

addAliasBtn.addEventListener('click', () => {
  syncAliasesFromDom();
  editingAliases.push({ alias: '', language: 'english' });
  renderAliasRows();
});

function renderAliasRows() {
  aliasRows.innerHTML = editingAliases.map((a, i) => `
    <div class="alias-row" data-index="${i}">
      <input
        type="text"
        value="${escHtml(a.alias)}"
        placeholder="Alternate spelling"
        onchange="editingAliases[${i}].alias = this.value"
      />
      <select onchange="editingAliases[${i}].language = this.value">
        <option value="english"  ${a.language === 'english'  ? 'selected' : ''}>English</option>
        <option value="mon"      ${a.language === 'mon'      ? 'selected' : ''}>Mon</option>
        <option value="burmese"  ${a.language === 'burmese'  ? 'selected' : ''}>Burmese</option>
      </select>
      <button class="btn btn--ghost btn--sm" onclick="removeAlias(${i})">✕</button>
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
    alias: row.querySelector('input').value.trim(),
    language: row.querySelector('select').value,
  })).filter(a => a.alias);
}

function clearNameForm() {
  document.getElementById('f-mon').value     = '';
  document.getElementById('f-burmese').value = '';
  document.getElementById('f-english').value = '';
  document.getElementById('f-meaning').value = '';
  document.getElementById('f-gender').value  = 'neutral';
  document.getElementById('f-verified').checked = false;
  editingAliases = [];
  renderAliasRows();
  hideAlert(nameModalAlert);
}

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
