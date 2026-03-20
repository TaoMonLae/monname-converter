/**
 * Mon Names Converter — Name Converter Frontend
 * ==============================================
 * Dictionary-first converter:
 * 1) full-name exact lookup
 * 2) internal longest-match segmentation if no exact
 * 3) variant chips for per-segment target selection
 */

const API_BASE = '/api';

const LANG_LABELS = { burmese: 'Burmese', mon: 'Mon', english: 'English' };
const LANGS = ['burmese', 'mon', 'english'];

// ── State ──────────────────────────────────────────────────
let fromLang = 'burmese';
let toLang   = 'mon';
let wordResults = []; // [{word, matches, selectedIndex}]
let history  = [];

try { history = JSON.parse(localStorage.getItem('converter-history') || '[]'); } catch(e) { history = []; }

// ── DOM refs ────────────────────────────────────────────────
const fromLangSelect      = document.getElementById('fromLang');
const toLangSelect        = document.getElementById('toLang');
const swapBtn             = document.getElementById('swapBtn');
const nameInput           = document.getElementById('nameInput');
const clearBtn            = document.getElementById('clearBtn');
const convertBtn          = document.getElementById('convertBtn');
const wordTokensSection   = document.getElementById('wordTokensSection');
const wordTokensDiv       = document.getElementById('wordTokens');
const resultSection       = document.getElementById('resultSection');
const resultTextEl        = document.getElementById('resultText');
const copyBtn             = document.getElementById('copyBtn');
const downloadCardBtn     = document.getElementById('downloadCardBtn');
const suggestWordBtn      = document.getElementById('suggestWordBtn');
const historyList         = document.getElementById('historyList');
const converterStatus     = document.getElementById('converterStatus');

// Suggest modal refs
const suggestModal        = document.getElementById('suggestModal');
const closeSuggestModal   = document.getElementById('closeSuggestModal');
const cancelSuggestBtn    = document.getElementById('cancelSuggestBtn');
const submitSuggestBtn    = document.getElementById('submitSuggestBtn');
const suggestAlert        = document.getElementById('suggestAlert');

// ── Init ────────────────────────────────────────────────────
fromLangSelect.value = fromLang;
toLangSelect.value   = toLang;
renderHistory();
setTimeout(() => { converterStatus.textContent = ''; }, 400);

// ── Language selector events ────────────────────────────────
fromLangSelect.addEventListener('change', () => {
  fromLang = fromLangSelect.value;
  if (fromLang === toLang) {
    toLang = LANGS.find(l => l !== fromLang);
    toLangSelect.value = toLang;
  }
});

toLangSelect.addEventListener('change', () => {
  toLang = toLangSelect.value;
  if (toLang === fromLang) {
    fromLang = LANGS.find(l => l !== toLang);
    fromLangSelect.value = fromLang;
  }
});

swapBtn.addEventListener('click', () => {
  [fromLang, toLang] = [toLang, fromLang];
  fromLangSelect.value = fromLang;
  toLangSelect.value   = toLang;
  if (wordResults.length > 0) convert();
});

// ── Input events ────────────────────────────────────────────
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); convert(); }
});

clearBtn.addEventListener('click', clearAll);
convertBtn.addEventListener('click', convert);

// ── Copy ────────────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  const text = getResultText();
  if (!text) return;
  (navigator.clipboard
    ? navigator.clipboard.writeText(text)
    : Promise.reject()
  ).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  }).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
  }).catch(() => {});
});

// ── Download card ───────────────────────────────────────────
downloadCardBtn.addEventListener('click', openDownloadCard);

// ── Suggest modal ───────────────────────────────────────────
suggestWordBtn.addEventListener('click', openSuggestModal);
closeSuggestModal.addEventListener('click', closeSuggest);
cancelSuggestBtn.addEventListener('click', closeSuggest);
suggestModal.addEventListener('click', e => { if (e.target === suggestModal) closeSuggest(); });

submitSuggestBtn.addEventListener('click', async () => {
  const mon      = document.getElementById('sug-mon').value.trim();
  const burmese  = document.getElementById('sug-burmese').value.trim();
  const english  = document.getElementById('sug-english').value.trim();
  const meaning  = document.getElementById('sug-meaning').value.trim();
  const gender   = document.getElementById('sug-gender').value;
  const submitted_by = document.getElementById('sug-submitter').value.trim();

  if (!mon && !burmese && !english) {
    showSuggestAlert('Please fill in at least one name field.', 'danger'); return;
  }

  submitSuggestBtn.disabled = true;
  submitSuggestBtn.textContent = 'Submitting…';

  try {
    const res = await fetch(`${API_BASE}/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mon, burmese, english, meaning, gender, submitted_by, aliases: [] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');
    showSuggestAlert(data.message || 'Suggestion submitted! Thank you.', 'success');
    clearSuggestForm();
  } catch (e) {
    showSuggestAlert(e.message || 'Something went wrong. Please try again.', 'danger');
  } finally {
    submitSuggestBtn.disabled = false;
    submitSuggestBtn.textContent = 'Submit suggestion →';
  }
});

// ═══════════════════════════════════════════════════════════
// ── Core: Convert ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function convert() {
  const input = nameInput.value.trim();
  if (!input) return;

  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting…';
  setStatus('Looking up…');

  wordTokensSection.classList.remove('hidden');
  wordTokensDiv.innerHTML = '<div class="spinner"></div>';
  resultSection.classList.add('hidden');
  downloadCardBtn.classList.add('hidden');

  try {
    // Step 1: Full-name exact lookup first (field or alias in source language)
    const exactMatches = await searchWord(input, { exactOnly: false, limit: 25 });
    const fullMatches = exactMatches.filter(r => isExactInSource(r, input));
    const hasFullExact = fullMatches.length > 0;

    if (hasFullExact) {
      wordResults = [{ word: input, matches: fullMatches, selectedIndex: 0, groupIndex: 0 }];
    } else {
      // Step 2: Dictionary-based segmentation on the full input string
      // (does not rely on whitespace splitting — finds word boundaries via the dictionary)
      const segments = await segmentInput(input);
      wordResults = (segments && segments.length > 0)
        ? segments
        : [{ word: input, matches: [], selectedIndex: 0, groupIndex: 0 }];
    }

    renderWordTokens();
    renderResult();

    // Show breakdown section when there are multiple segments or any segment has multiple variants
    const needsBreakdown = wordResults.length > 1 || wordResults.some(wr => wr.matches.length > 1);
    wordTokensSection.classList.toggle('hidden', !needsBreakdown);

    const hasResult = wordResults.some(wr => wr.matches.length > 0);
    if (hasResult) {
      downloadCardBtn.classList.remove('hidden');
      saveHistory(input, getResultText());
      renderHistory();
    }

    setStatus('');
  } catch (e) {
    wordTokensDiv.innerHTML = `<div class="alert alert--danger">Conversion failed — please try again.</div>`;
    setStatus('');
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
  }
}

function isExactInSource(entry, sourceText) {
  const q = sourceText.trim();
  const value = entry[fromLang];
  if (value && value.trim() === q) return true;

  if (!Array.isArray(entry.aliases)) return false;
  return entry.aliases.some(a =>
    a &&
    a.language === fromLang &&
    typeof a.alias === 'string' &&
    a.alias.trim() === q
  );
}

async function searchWord(word, { exactOnly = false, limit = 5 } = {}) {
  try {
    const params = new URLSearchParams({ q: word, lang: fromLang });
    const res = await fetch(`${API_BASE}/search?${params}`);
    if (!res.ok) return [];
    const { results } = await res.json();

    // Prefer exact matches in the source field or matching alias.
    const exact = results.filter(r => isExactInSource(r, word));
    if (exactOnly) return exact;

    return exact.length > 0 ? exact : results.slice(0, limit);
  } catch (e) {
    return [];
  }
}

/**
 * Greedy longest-match-first segmentation on an arbitrary input string.
 *
 * Does NOT rely on whitespace splitting. It searches the dictionary for the
 * longest entry that is a prefix of the remaining input, then recursively
 * segments the rest. Leading whitespace in the remaining input signals a
 * new group boundary (segments will be joined with a space in the result).
 *
 * When a prefix is matched, ALL dictionary entries with that exact source-
 * language value are collected as variant matches, so the user can choose
 * among them in the UI.
 *
 * Returns an array of wordResult-shaped objects, or null if no complete
 * segmentation is possible from this position.
 *
 * @param {string} input     - Remaining input to segment (may have leading whitespace)
 * @param {number} depth     - Recursion depth guard (max 10)
 * @param {number} groupIdx  - Current group index for output concatenation
 */
async function segmentInput(input, depth = 0, groupIdx = 0) {
  if (depth > 10) return null;

  // Skip leading whitespace; a space signals a new group (output joined with space)
  const trimmed = input.replace(/^\s+/, '');
  if (!trimmed) return []; // consumed all input successfully

  const hasLeadingSpace = input.length !== trimmed.length;
  const myGroupIdx = hasLeadingSpace ? groupIdx + 1 : groupIdx;

  let results = [];
  try {
    const params = new URLSearchParams({ q: trimmed, lang: fromLang });
    const res = await fetch(`${API_BASE}/search?${params}`);
    if (!res.ok) return null;
    ({ results } = await res.json());
  } catch (e) {
    return null;
  }

  // Collect candidates whose source-language value is a prefix of `trimmed`,
  // then sort longest-first so we always try the most specific match first.
  const prefixCandidates = results
    .filter(r => {
      const val = r[fromLang];
      return val && trimmed.startsWith(val.trim());
    })
    .sort((a, b) => b[fromLang].trim().length - a[fromLang].trim().length);

  for (const candidate of prefixCandidates) {
    const val = candidate[fromLang].trim();
    const remainder = trimmed.slice(val.length);

    // Fetch all dictionary entries that exactly match this segment value,
    // so the user can pick among multiple valid target-language forms.
    const allMatches = await searchWord(val, { exactOnly: true, limit: 25 });
    const matches = allMatches.length ? allMatches : [candidate];

    if (!remainder) {
      // This prefix covers the entire remaining input — done.
      return [{ word: val, matches, selectedIndex: 0, groupIndex: myGroupIdx }];
    }

    // Try to segment what's left; only accept this candidate if the rest
    // can also be fully segmented (greedy but complete).
    const restSegments = await segmentInput(remainder, depth + 1, myGroupIdx);
    if (restSegments !== null) {
      return [
        { word: val, matches, selectedIndex: 0, groupIndex: myGroupIdx },
        ...restSegments,
      ];
    }
    // This candidate leaves an unsegmentable tail; try the next-longest prefix.
  }

  return null; // no complete segmentation found from this position
}

// ═══════════════════════════════════════════════════════════
// ── Rendering ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function getResultText() {
  // Group segments by their original word (groupIndex).
  // Segments from the same input word are joined without space;
  // results from different input words are separated by a space.
  const groups = new Map();
  wordResults.forEach(wr => {
    const gi = wr.groupIndex ?? 0;
    if (!groups.has(gi)) groups.set(gi, []);
    groups.get(gi).push(wr);
  });

  return [...groups.values()].map(group =>
    group.map(wr => {
      if (wr.matches.length === 0) return wr.word;
      const match = wr.matches[wr.selectedIndex] || wr.matches[0];
      return match[toLang] || match[fromLang] || wr.word;
    }).join('')
  ).join(' ');
}

function renderResult() {
  const text = getResultText();
  resultTextEl.className = `result-text ${langClass(toLang)}`;
  resultTextEl.textContent = text;

  const scriptLabel = toLang === 'burmese' ? 'ဗမာ' : toLang === 'mon' ? 'မန်' : '';
  const resultLabel = resultSection.querySelector('.input-label');
  if (resultLabel) {
    resultLabel.textContent = `Result in ${LANG_LABELS[toLang]}${scriptLabel ? ` (${scriptLabel})` : ''}`;
  }

  resultSection.classList.remove('hidden');
}

function renderWordTokens() {
  const tokens = wordResults.map((wr, i) => renderToken(wr, i)).join('');
  wordTokensDiv.innerHTML = tokens || '';

  // Select a variant from chips.
  wordTokensDiv.querySelectorAll('.variant-chip').forEach(btn => {
    btn.addEventListener('click', e => {
      const wi = parseInt(btn.dataset.wordIndex, 10);
      const mi = parseInt(btn.dataset.matchIndex, 10);
      wordResults[wi].selectedIndex = mi;
      renderWordTokens();
      renderResult();
    });
  });
}

function renderToken(wr, i) {
  const { word, matches, selectedIndex } = wr;

  if (matches.length === 0) {
    return `<div class="word-token word-token--unknown">
      <span class="${langClass(fromLang)}">${escHtml(word)}</span>
      <span class="word-token__badge">not found</span>
    </div>`;
  }

  const match   = matches[selectedIndex] || matches[0];
  const srcText = match[fromLang] || word;
  const tgtText = match[toLang]   || '—';
  const srcClass = langClass(fromLang);
  const tgtClass = langClass(toLang);

  if (matches.length === 1) {
    return `<div class="word-token word-token--single">
      <span class="${srcClass}">${escHtml(srcText)}</span>
      <span class="word-token__arrow">→</span>
      <span class="${tgtClass}">${escHtml(tgtText)}</span>
    </div>`;
  }

  // Multiple matches — build variant chips
  const options = matches.map((m, j) => {
    const oSrc     = m[fromLang] || word;
    const oTgt     = m[toLang]   || '—';
    const oMeaning = m.meaning   ? m.meaning.substring(0, 40) : '';
    return `<button
        type="button"
        class="variant-chip${j === selectedIndex ? ' active' : ''}"
        data-word-index="${i}"
        data-match-index="${j}">
      <span class="variant-chip__target ${tgtClass}">${escHtml(oTgt)}</span>
      <span class="variant-chip__source ${srcClass}">${escHtml(oSrc)}</span>
      ${oMeaning ? `<span class="variant-chip__meaning">${escHtml(oMeaning)}</span>` : ''}
    </button>`;
  }).join('');

  return `<div class="word-token word-token--multi" data-index="${i}">
    <div class="word-token__summary">
      <span class="${srcClass}">${escHtml(srcText)}</span>
      <span class="word-token__arrow">→</span>
      <span class="${tgtClass}">${escHtml(tgtText)}</span>
      <span class="word-token__count">${matches.length} variants</span>
    </div>
    <div class="variant-chip-list" role="listbox" aria-label="Choose match for ${escHtml(word)}">
      ${options}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// ── Download Card ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function openDownloadCard() {
  const input  = nameInput.value.trim();
  const result = getResultText();

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop open';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Name Card</h3>
        <button class="modal__close" aria-label="Close">×</button>
      </div>
      <div class="modal__body">
        <div class="name-card-preview">
          <div class="name-card-preview__lang">${escHtml(LANG_LABELS[fromLang])}</div>
          <div class="name-card-preview__name ${langClass(fromLang)}">${escHtml(input)}</div>
          <div class="name-card-preview__arrow">↓</div>
          <div class="name-card-preview__lang">${escHtml(LANG_LABELS[toLang])}</div>
          <div class="name-card-preview__name ${langClass(toLang)} name-card-preview__accent">${escHtml(result)}</div>
        </div>
      </div>
      <div class="modal__footer">
        <button class="btn btn--ghost" id="_closeCardBtn">Close</button>
        <button class="btn btn--primary" id="_printCardBtn">Print / Save as PDF</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('.modal__close').onclick = () => modal.remove();
  modal.querySelector('#_closeCardBtn').onclick = () => modal.remove();
  modal.querySelector('#_printCardBtn').onclick = () => window.print();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ═══════════════════════════════════════════════════════════
// ── Suggest Modal ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function openSuggestModal() {
  // Pre-fill the from-language field with any unmatched words
  const unmatched = wordResults.filter(wr => wr.matches.length === 0).map(wr => wr.word).join(' ');
  if (unmatched) {
    const field = document.getElementById(`sug-${fromLang}`);
    if (field) field.value = unmatched;
  }
  suggestModal.classList.add('open');
  suggestModal.querySelector('input').focus();
}

function closeSuggest() {
  suggestModal.classList.remove('open');
  hideSuggestAlert();
}

function clearSuggestForm() {
  ['sug-mon', 'sug-burmese', 'sug-english', 'sug-meaning', 'sug-submitter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('sug-gender').value = 'neutral';
}

function showSuggestAlert(msg, type) {
  suggestAlert.className = `alert alert--${type}`;
  suggestAlert.textContent = msg;
  suggestAlert.style.display = 'block';
}

function hideSuggestAlert() {
  suggestAlert.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// ── History ────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function saveHistory(input, result) {
  const entry = { input, result, from: fromLang, to: toLang, ts: Date.now() };
  history = [entry, ...history.filter(h => !(h.input === input && h.from === fromLang && h.to === toLang))].slice(0, 10);
  try { localStorage.setItem('converter-history', JSON.stringify(history)); } catch(e) {}
}

function renderHistory() {
  if (!historyList) return;
  if (history.length === 0) {
    historyList.innerHTML = '<p class="text-muted text-small" style="padding:var(--space-sm) 0">No recent conversions yet.</p>';
    return;
  }
  historyList.innerHTML = history.map((h, i) => `
    <div class="history-item" data-hi="${i}">
      <span class="history-item__from ${langClass(h.from)}">${escHtml(h.input)}</span>
      <span class="history-item__arrow">→</span>
      <span class="history-item__to ${langClass(h.to)}">${escHtml(h.result)}</span>
    </div>`).join('');

  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = history[parseInt(item.dataset.hi, 10)];
      if (!h) return;
      nameInput.value    = h.input;
      fromLang           = h.from;
      toLang             = h.to;
      fromLangSelect.value = fromLang;
      toLangSelect.value   = toLang;
      convert();
    });
  });
}

// ═══════════════════════════════════════════════════════════
// ── Utilities ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function clearAll() {
  nameInput.value = '';
  wordResults = [];
  wordTokensSection.classList.add('hidden');
  wordTokensDiv.innerHTML = '';
  resultSection.classList.add('hidden');
  downloadCardBtn.classList.add('hidden');
  setStatus('');
}

function setStatus(msg) {
  if (converterStatus) converterStatus.textContent = msg;
}

function langClass(lang) {
  if (lang === 'mon')     return 'mon';
  if (lang === 'burmese') return 'bur';
  return '';
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
