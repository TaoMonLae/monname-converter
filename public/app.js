const API_BASE = '/api';

const LANG_LABELS = { burmese: 'Burmese', mon: 'Mon', english: 'English' };
const LANGS = ['burmese', 'mon', 'english'];

let fromLang = 'burmese';
let toLang = 'mon';
let wordResults = [];
let history = [];

try { history = JSON.parse(localStorage.getItem('converter-history') || '[]'); }
catch (e) { history = []; }

const fromLangSelect = document.getElementById('fromLang');
const toLangSelect = document.getElementById('toLang');
const swapBtn = document.getElementById('swapBtn');
const nameInput = document.getElementById('nameInput');
const clearBtn = document.getElementById('clearBtn');
const convertBtn = document.getElementById('convertBtn');
const wordTokensSection = document.getElementById('wordTokensSection');
const wordTokensDiv = document.getElementById('wordTokens');
const resultSection = document.getElementById('resultSection');
const resultTextEl = document.getElementById('resultText');
const copyBtn = document.getElementById('copyBtn');
const downloadCardBtn = document.getElementById('downloadCardBtn');
const suggestWordBtn = document.getElementById('suggestWordBtn');
const historyList = document.getElementById('historyList');
const converterStatus = document.getElementById('converterStatus');

const suggestModal = document.getElementById('suggestModal');
const closeSuggestModal = document.getElementById('closeSuggestModal');
const cancelSuggestBtn = document.getElementById('cancelSuggestBtn');
const submitSuggestBtn = document.getElementById('submitSuggestBtn');
const suggestAlert = document.getElementById('suggestAlert');

fromLangSelect.value = fromLang;
toLangSelect.value = toLang;
renderHistory();
setTimeout(() => { converterStatus.textContent = ''; }, 400);

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
  toLangSelect.value = toLang;
  if (wordResults.length > 0) convert();
});

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); convert(); }
});

clearBtn.addEventListener('click', clearAll);
convertBtn.addEventListener('click', convert);

copyBtn.addEventListener('click', () => {
  const text = getResultText();
  if (!text) return;
  (navigator.clipboard
    ? navigator.clipboard.writeText(text)
    : Promise.reject()
  ).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
  }).catch(() => {});
});

downloadCardBtn.addEventListener('click', openDownloadCard);

suggestWordBtn.addEventListener('click', openSuggestModal);
closeSuggestModal.addEventListener('click', closeSuggest);
cancelSuggestBtn.addEventListener('click', closeSuggest);
suggestModal.addEventListener('click', e => { if (e.target === suggestModal) closeSuggest(); });

submitSuggestBtn.addEventListener('click', async () => {
  const mon = document.getElementById('sug-mon').value.trim();
  const burmese = document.getElementById('sug-burmese').value.trim();
  const english = document.getElementById('sug-english').value.trim();
  const meaning = document.getElementById('sug-meaning').value.trim();
  const gender = document.getElementById('sug-gender').value;
  const submitted_by = document.getElementById('sug-submitter').value.trim();

  if (!mon && !burmese && !english) {
    showSuggestAlert('Please fill in at least one name field.', 'danger');
    return;
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
    const params = new URLSearchParams({ q: input, from: fromLang, to: toLang });
    const res = await fetch(`${API_BASE}/convert?${params}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Conversion failed');

    wordResults = Array.isArray(data.segments) ? data.segments : [];
    if (wordResults.length === 0) {
      wordResults = [{
        source: input,
        separatorBefore: '',
        fromLang,
        toLang,
        matched: false,
        options: [{ [fromLang]: input, [toLang]: input, verified: false, preferred: true }],
        selectedIndex: 0,
      }];
    }

    renderWordTokens();
    renderResult();

    const needsBreakdown = wordResults.length > 1 || wordResults.some(wr => (wr.options || []).length > 1 || !wr.matched);
    wordTokensSection.classList.toggle('hidden', !needsBreakdown);

    downloadCardBtn.classList.remove('hidden');
    saveHistory(input, getResultText());
    renderHistory();
    setStatus('');
  } catch (e) {
    wordTokensDiv.innerHTML = `<div class="alert alert--danger">${escHtml(e.message || 'Conversion failed — please try again.')}</div>`;
    setStatus('');
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
  }
}

function getResultText() {
  return wordResults.map(wr => {
    const choice = (wr.options || [])[wr.selectedIndex || 0] || (wr.options || [])[0] || null;
    const sourceText = wr.source || '';
    const text = choice ? (choice[toLang] || choice[fromLang] || sourceText) : sourceText;
    return `${wr.separatorBefore || ''}${text || ''}`;
  }).join('').trim();
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

  wordTokensDiv.querySelectorAll('.variant-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const wi = parseInt(btn.dataset.wordIndex, 10);
      const mi = parseInt(btn.dataset.matchIndex, 10);
      wordResults[wi].selectedIndex = mi;
      renderWordTokens();
      renderResult();
    });
  });
}

function renderToken(wr, i) {
  const sourceText = wr.source || '';
  const options = Array.isArray(wr.options) ? wr.options : [];
  const selectedIndex = wr.selectedIndex || 0;
  const srcClass = langClass(fromLang);
  const tgtClass = langClass(toLang);

  if (options.length === 0 || !wr.matched) {
    return `<div class="word-token word-token--unknown">
      <span class="${srcClass}">${escHtml(sourceText)}</span>
      <span class="word-token__badge">not found</span>
    </div>`;
  }

  const selected = options[selectedIndex] || options[0];
  const src = selected[fromLang] || sourceText;
  const tgt = selected[toLang] || sourceText;

  if (options.length === 1) {
    return `<div class="word-token word-token--single">
      <span class="${srcClass}">${escHtml(src)}</span>
      <span class="word-token__arrow">→</span>
      <span class="${tgtClass}">${escHtml(tgt)}</span>
    </div>`;
  }

  const chips = options.map((option, idx) => {
    const oSrc = option[fromLang] || sourceText;
    const oTgt = option[toLang] || sourceText;
    const oMeaning = option.meaning ? String(option.meaning).substring(0, 40) : '';

    return `<button
      type="button"
      class="variant-chip${idx === selectedIndex ? ' active' : ''}"
      data-word-index="${i}"
      data-match-index="${idx}">
      <span class="variant-chip__target ${tgtClass}">${escHtml(oTgt)}</span>
      <span class="variant-chip__source ${srcClass}">${escHtml(oSrc)}</span>
      ${oMeaning ? `<span class="variant-chip__meaning">${escHtml(oMeaning)}</span>` : ''}
    </button>`;
  }).join('');

  return `<div class="word-token word-token--multi" data-index="${i}">
    <div class="word-token__summary">
      <span class="${srcClass}">${escHtml(src)}</span>
      <span class="word-token__arrow">→</span>
      <span class="${tgtClass}">${escHtml(tgt)}</span>
      <span class="word-token__count">${options.length} variants</span>
    </div>
    <div class="variant-chip-list" role="listbox" aria-label="Choose match for ${escHtml(sourceText)}">${chips}</div>
  </div>`;
}

function openDownloadCard() {
  const input = nameInput.value.trim();
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

function openSuggestModal() {
  const unmatched = wordResults
    .filter(wr => !wr.matched)
    .map(wr => wr.source)
    .join(' ')
    .trim();

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

function saveHistory(input, result) {
  const entry = { input, result, from: fromLang, to: toLang, ts: Date.now() };
  history = [entry, ...history.filter(h => !(h.input === input && h.from === fromLang && h.to === toLang))].slice(0, 10);
  try { localStorage.setItem('converter-history', JSON.stringify(history)); }
  catch (e) {}
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

      nameInput.value = h.input;
      fromLang = h.from;
      toLang = h.to;
      fromLangSelect.value = fromLang;
      toLangSelect.value = toLang;
      convert();
    });
  });
}

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
  if (lang === 'mon') return 'mon';
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
