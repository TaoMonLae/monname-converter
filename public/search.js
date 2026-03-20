/**
 * Mon Names Converter — Dictionary Search Frontend
 * =================================================
 * Handles: search, result rendering, suggest form submission.
 */

const API_BASE = '/api';

let currentLang = 'all';
let searchDebounceTimer = null;
let lastQuery = '';

const searchInput    = document.getElementById('searchInput');
const searchBtn      = document.getElementById('searchBtn');
const resultsSection = document.getElementById('resultsSection');
const suggestForm    = document.getElementById('suggestForm');
const suggestToggle  = document.getElementById('suggestToggle');
const openSuggestBtn = document.getElementById('openSuggestBtn');
const cancelSuggestBtn = document.getElementById('cancelSuggestBtn');
const submitSuggestBtn = document.getElementById('submitSuggestBtn');
const suggestAlert   = document.getElementById('suggestAlert');
const langChips      = document.querySelectorAll('.lang-chip');

// ── Search ──────────────────────────────────────────────────

async function search(query) {
  query = query.trim();
  if (!query) { clearResults(); return; }

  lastQuery = query;
  showLoading();

  try {
    const params = new URLSearchParams({ q: query, lang: currentLang });
    const res = await fetch(`${API_BASE}/search?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { results } = await res.json();
    renderResults(results, query);
  } catch (e) {
    renderError('Search failed. Please try again.');
  }
}

function debounceSearch(query) {
  clearTimeout(searchDebounceTimer);
  if (!query.trim()) { clearResults(); return; }
  searchDebounceTimer = setTimeout(() => search(query), 300);
}

searchInput.addEventListener('input', e => debounceSearch(e.target.value));
searchBtn.addEventListener('click', () => search(searchInput.value));
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchDebounceTimer); search(searchInput.value); }
});

langChips.forEach(chip => {
  chip.addEventListener('click', () => {
    langChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentLang = chip.dataset.lang;
    if (searchInput.value.trim()) search(searchInput.value);
  });
});

// ── Rendering ───────────────────────────────────────────────

function showLoading() {
  resultsSection.innerHTML = `<div class="spinner" aria-label="Loading…"></div>`;
}

function clearResults() {
  resultsSection.innerHTML = '';
  lastQuery = '';
}

function renderError(msg) {
  resultsSection.innerHTML = `<div class="alert alert--danger">${escHtml(msg)}</div>`;
}

function renderResults(results, query) {
  if (!results.length) { renderNoResults(query); return; }

  const count = results.length;
  const meta = `<div class="results-meta">
    <span>${count} result${count !== 1 ? 's' : ''} for "<strong>${escHtml(query)}</strong>"</span>
  </div>`;

  const cards = results.map((name, i) => renderNameCard(name, i)).join('');
  resultsSection.innerHTML = `${meta}<div class="results-list">${cards}</div>`;
}

function renderNoResults(query) {
  resultsSection.innerHTML = `
    <div class="empty-state">
      <div class="empty-state__icon">🔍</div>
      <div class="empty-state__title">No names found</div>
      <p class="empty-state__text">
        We couldn't find a match for "<strong>${escHtml(query)}</strong>".
        Try a different spelling or language, or suggest the name below.
      </p>
    </div>`;
  autoFillSuggest(query);
}

function renderNameCard(name, index) {
  const genderBadge = name.gender !== 'neutral'
    ? `<span class="badge badge--${name.gender}">${capitalize(name.gender)}</span>` : '';
  const verifiedBadge = name.verified
    ? `<span class="badge badge--verified">Verified</span>` : '';

  const monVal = name.mon     ? `<span class="mon">${escHtml(name.mon)}</span>`     : `<span class="empty">—</span>`;
  const burVal = name.burmese ? `<span class="bur">${escHtml(name.burmese)}</span>` : `<span class="empty">—</span>`;
  const engVal = name.english ? `<span class="eng">${escHtml(name.english)}</span>` : `<span class="empty">—</span>`;

  const meaningHtml = name.meaning
    ? `<div class="name-card__meaning">${escHtml(name.meaning)}</div>` : '';
  const aliasesHtml = (name.aliases && name.aliases.length)
    ? `<div class="name-card__aliases">
        ${name.aliases.map(a => `<span class="alias-pill" title="${escHtml(a.language)}">${escHtml(a.alias)}</span>`).join('')}
      </div>` : '';

  return `
    <article class="name-card" style="animation-delay:${index * 0.04}s">
      <div class="name-card__header">
        <div style="font-size:0.75rem; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.08em">Name #${name.id}</div>
        <div class="name-card__badges">${genderBadge}${verifiedBadge}</div>
      </div>
      <div class="name-card__body">
        <div class="name-field">
          <div class="name-field__lang">Mon</div>
          <div class="name-field__value ${!name.mon ? 'empty' : ''}">${monVal}</div>
        </div>
        <div class="name-field">
          <div class="name-field__lang">Burmese</div>
          <div class="name-field__value ${!name.burmese ? 'empty' : ''}">${burVal}</div>
        </div>
        <div class="name-field">
          <div class="name-field__lang">English</div>
          <div class="name-field__value ${!name.english ? 'empty' : ''}">${engVal}</div>
        </div>
      </div>
      ${meaningHtml}
      ${aliasesHtml}
    </article>`;
}

// ── Suggest Form ─────────────────────────────────────────────

function openSuggestForm() {
  suggestForm.style.display = 'block';
  suggestToggle.style.display = 'none';
  suggestForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeSuggestForm() {
  suggestForm.style.display = 'none';
  suggestToggle.style.display = 'block';
  clearSuggestForm();
}

function clearSuggestForm() {
  ['sug-mon', 'sug-burmese', 'sug-english', 'sug-meaning', 'sug-aliases', 'sug-submitter'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('sug-gender').value = 'neutral';
  hideSuggestAlert();
}

function autoFillSuggest(query) {
  if (!query) return;
  const script = detectScript(query);
  if (script === 'mon' || script === 'burmese') {
    document.getElementById('sug-mon').value = query;
  } else if (script === 'english') {
    document.getElementById('sug-english').value = query;
  }
}

openSuggestBtn.addEventListener('click', openSuggestForm);
cancelSuggestBtn.addEventListener('click', closeSuggestForm);

submitSuggestBtn.addEventListener('click', async () => {
  const mon      = document.getElementById('sug-mon').value.trim();
  const burmese  = document.getElementById('sug-burmese').value.trim();
  const english  = document.getElementById('sug-english').value.trim();
  const meaning  = document.getElementById('sug-meaning').value.trim();
  const gender   = document.getElementById('sug-gender').value;
  const submitted_by = document.getElementById('sug-submitter').value.trim();
  const aliasesRaw = document.getElementById('sug-aliases').value.trim();

  if (!mon && !burmese && !english) {
    showSuggestAlert('Please fill in at least one name field.', 'danger'); return;
  }

  const aliases = aliasesRaw
    ? aliasesRaw.split(',').map(a => a.trim()).filter(Boolean).map(alias => ({ alias, language: 'english' }))
    : [];

  submitSuggestBtn.disabled = true;
  submitSuggestBtn.textContent = 'Submitting…';

  try {
    const res = await fetch(`${API_BASE}/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mon, burmese, english, meaning, gender, submitted_by, aliases }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');
    clearSuggestForm();
    suggestForm.style.display = 'none';
    suggestToggle.style.display = 'block';
    showSuggestAlert(data.message || 'Suggestion submitted!', 'success');
  } catch (e) {
    showSuggestAlert(e.message || 'Something went wrong.', 'danger');
  } finally {
    submitSuggestBtn.disabled = false;
    submitSuggestBtn.textContent = 'Submit suggestion →';
  }
});

function showSuggestAlert(msg, type) {
  suggestAlert.className = `alert alert--${type}`;
  suggestAlert.textContent = msg;
  suggestAlert.style.display = 'block';
}

function hideSuggestAlert() { suggestAlert.style.display = 'none'; }

// ── Helpers ──────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function capitalize(str) { return str ? str[0].toUpperCase() + str.slice(1) : ''; }

function detectScript(text) {
  if (/[\uAA60-\uAA7F]/.test(text)) return 'mon';
  if (/[\u1000-\u109F]/.test(text)) return 'burmese';
  if (/[a-zA-Z]/.test(text)) return 'english';
  return 'unknown';
}

// ── Night mode toggle ─────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);

  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  function updateBtn(theme) {
    btn.textContent = theme === 'dark' ? '☀ Light' : '🌙 Dark';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  updateBtn(saved);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateBtn(next);
  });
})();

// ── Init ─────────────────────────────────────────────────────
searchInput.focus();

const urlParams = new URLSearchParams(window.location.search);
const preSearch = urlParams.get('q');
if (preSearch) { searchInput.value = preSearch; search(preSearch); }
