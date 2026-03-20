/**
 * Mon Names Converter — Name Converter Frontend
 * ==============================================
 * Converts names word-by-word using the dictionary API,
 * concatenates results, and lets users disambiguate words
 * that have multiple matches.
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

// ── Close dropdowns when clicking outside ──────────────────
document.addEventListener('click', e => {
  if (!e.target.closest('.word-token--multi')) {
    document.querySelectorAll('.word-token--multi.open').forEach(t => t.classList.remove('open'));
  }
});

// ═══════════════════════════════════════════════════════════
// ── Core: Convert ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

async function convert() {
  const input = nameInput.value.trim();
  if (!input) return;

  const words = input.split(/\s+/).filter(Boolean);

  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting…';
  setStatus('Looking up words…');

  wordTokensSection.classList.remove('hidden');
  wordTokensDiv.innerHTML = '<div class="spinner"></div>';
  resultSection.classList.add('hidden');
  downloadCardBtn.classList.add('hidden');

  try {
    const results = await Promise.all(words.map(w => searchWord(w)));

    const rawWordResults = words.map((word, i) => ({
      word,
      matches: results[i],
      selectedIndex: 0,
      groupIndex: i,
    }));

    // For any word that wasn't found, try to segment it into known sub-words
    const expandedResults = [];
    for (const wr of rawWordResults) {
      if (wr.matches.length === 0) {
        const segments = await segmentUnknownWord(wr.word);
        if (segments) {
          // Assign parent's groupIndex so segments concatenate without spaces
          segments.forEach(s => { s.groupIndex = wr.groupIndex; });
          expandedResults.push(...segments);
        } else {
          expandedResults.push(wr);
        }
      } else {
        expandedResults.push(wr);
      }
    }
    wordResults = expandedResults;

    renderWordTokens();
    renderResult();

    // Only show word breakdown section when disambiguation is needed
    const needsDisambiguation = wordResults.some(wr => wr.matches.length > 1);
    if (needsDisambiguation) {
      wordTokensSection.classList.remove('hidden');
    } else {
      wordTokensSection.classList.add('hidden');
    }

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

async function searchWord(word) {
  try {
    const params = new URLSearchParams({ q: word, lang: fromLang });
    const res = await fetch(`${API_BASE}/search?${params}`);
    if (!res.ok) return [];
    const { results } = await res.json();

    // Prefer exact matches in the from-language field
    const exact = results.filter(r => {
      const val = r[fromLang];
      return val && val.trim() === word.trim();
    });

    return exact.length > 0 ? exact : results.slice(0, 5);
  } catch (e) {
    return [];
  }
}

/**
 * Try to segment an unknown compound word into known sub-words.
 * Uses a greedy prefix search: find the longest database entry that is a
 * prefix of the input, then recursively segment the remainder.
 * Returns an array of wordResult-shaped objects, or null if no split found.
 */
async function segmentUnknownWord(word, depth = 0) {
  if (depth > 4 || word.length === 0) return null;

  try {
    const params = new URLSearchParams({ q: word, lang: fromLang });
    const res = await fetch(`${API_BASE}/search?${params}`);
    if (!res.ok) return null;
    const { results } = await res.json();

    // Find results whose source-language value is a strict prefix of `word`
    // (not the whole word — that would have been caught by searchWord already)
    const prefixCandidates = results
      .filter(r => {
        const val = r[fromLang];
        return val && val.length < word.length && word.startsWith(val);
      })
      // Prefer longer (more specific) prefixes first
      .sort((a, b) => b[fromLang].length - a[fromLang].length);

    for (const r of prefixCandidates) {
      const val = r[fromLang];
      const remainder = word.slice(val.length);

      // Try to find the remainder as a direct match
      const remainderMatches = await searchWord(remainder);
      if (remainderMatches.length > 0) {
        return [
          { word: val, matches: [r], selectedIndex: 0 },
          { word: remainder, matches: remainderMatches, selectedIndex: 0 },
        ];
      }

      // Recurse: try to further segment the remainder
      const subSegments = await segmentUnknownWord(remainder, depth + 1);
      if (subSegments) {
        return [{ word: val, matches: [r], selectedIndex: 0 }, ...subSegments];
      }
    }
  } catch (e) {
    // Segmentation is best-effort; fall back to "not found"
  }

  return null;
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

  // Toggle dropdowns on click
  wordTokensDiv.querySelectorAll('.word-token--multi').forEach(token => {
    token.addEventListener('click', e => {
      const wasOpen = token.classList.contains('open');
      document.querySelectorAll('.word-token--multi.open').forEach(t => t.classList.remove('open'));
      if (!wasOpen) token.classList.add('open');
    });
  });

  // Select an option from a multi-match dropdown
  wordTokensDiv.querySelectorAll('.word-token__option').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wi = parseInt(btn.dataset.wordIndex, 10);
      const mi = parseInt(btn.dataset.matchIndex, 10);
      wordResults[wi].selectedIndex = mi;
      btn.closest('.word-token--multi').classList.remove('open');
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

  // Multiple matches — build dropdown options
  const options = matches.map((m, j) => {
    const oSrc     = m[fromLang] || word;
    const oTgt     = m[toLang]   || '—';
    const oMeaning = m.meaning   ? m.meaning.substring(0, 40) : '';
    return `<button
        class="word-token__option${j === selectedIndex ? ' active' : ''}"
        data-word-index="${i}"
        data-match-index="${j}">
      <span class="${srcClass}">${escHtml(oSrc)}</span>
      <span class="word-token__option-sep">→</span>
      <span class="${tgtClass}">${escHtml(oTgt)}</span>
      ${oMeaning ? `<span class="word-token__meaning">${escHtml(oMeaning)}</span>` : ''}
    </button>`;
  }).join('');

  return `<div class="word-token word-token--multi" data-index="${i}">
    <span class="${srcClass}">${escHtml(srcText)}</span>
    <span class="word-token__arrow">→</span>
    <span class="${tgtClass}">${escHtml(tgtText)}</span>
    <span class="word-token__count">${matches.length}</span>
    <svg class="word-token__chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>
    <div class="word-token__dropdown" role="listbox" aria-label="Choose match for ${escHtml(word)}">
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
