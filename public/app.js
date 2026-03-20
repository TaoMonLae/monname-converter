const API_BASE = '/api';

const LANG_LABELS = { burmese: 'Burmese', mon: 'Mon', english: 'English' };
const LANGS = ['mon', 'burmese', 'english'];

// Input elements for each language
const monInput     = document.getElementById('monInput');
const burmeseInput = document.getElementById('burmeseInput');
const englishInput = document.getElementById('englishInput');

const colMon     = document.getElementById('colMon');
const colBurmese = document.getElementById('colBurmese');
const colEnglish = document.getElementById('colEnglish');

const inputsByLang = { mon: monInput, burmese: burmeseInput, english: englishInput };
const colsByLang   = { mon: colMon,   burmese: colBurmese,   english: colEnglish };

const clearBtn     = document.getElementById('clearBtn');
const convertBtn   = document.getElementById('convertBtn');

const wordTokensSection = document.getElementById('wordTokensSection');
const wordTokensDiv     = document.getElementById('wordTokens');
const resultSection     = document.getElementById('resultSection'); // hidden stub

const copyMonBtn     = document.getElementById('copyMonBtn');
const copyBurmeseBtn = document.getElementById('copyBurmeseBtn');
const copyEnglishBtn = document.getElementById('copyEnglishBtn');

const downloadCardBtn = document.getElementById('downloadCardBtn');
const suggestWordBtn  = document.getElementById('suggestWordBtn');
const historyList     = document.getElementById('historyList');
const converterStatus = document.getElementById('converterStatus');

const suggestModal      = document.getElementById('suggestModal');
const closeSuggestModal = document.getElementById('closeSuggestModal');
const cancelSuggestBtn  = document.getElementById('cancelSuggestBtn');
const submitSuggestBtn  = document.getElementById('submitSuggestBtn');
const suggestAlert      = document.getElementById('suggestAlert');

// State
let fromLang       = 'burmese';   // which box the user last typed in
let wordResults    = [];
let conversionMode = '';
let columnResults  = { mon: '', burmese: '', english: '' };

let history = [];
try { history = JSON.parse(localStorage.getItem('converter-history') || '[]'); }
catch (e) { history = []; }

renderHistory();
setTimeout(() => { if (converterStatus) converterStatus.textContent = ''; }, 400);

// ── Wire up each input box ────────────────────────────────────

LANGS.forEach(lang => {
  const el = inputsByLang[lang];
  if (!el) return;

  // Enter key → convert (Shift+Enter inserts newline)
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      fromLang = lang;
      markActiveColumn(lang);
      convert();
    }
  });

  // Focus → record which language is being typed
  el.addEventListener('focus', () => {
    fromLang = lang;
    markActiveColumn(lang);
  });
});

clearBtn.addEventListener('click', clearAll);
convertBtn.addEventListener('click', () => {
  // Determine source: find the box that has content and was last focused
  // Fall back to whichever box has content
  const active = LANGS.find(l => inputsByLang[l] === document.activeElement)
    || LANGS.find(l => inputsByLang[l]?.value.trim())
    || fromLang;
  fromLang = active;
  convert();
});

copyMonBtn?.addEventListener('click',     () => copyColumn('mon',     copyMonBtn));
copyBurmeseBtn?.addEventListener('click', () => copyColumn('burmese', copyBurmeseBtn));
copyEnglishBtn?.addEventListener('click', () => copyColumn('english', copyEnglishBtn));

downloadCardBtn?.addEventListener('click', openDownloadCard);
suggestWordBtn?.addEventListener('click', openSuggestModal);
closeSuggestModal?.addEventListener('click', closeSuggest);
cancelSuggestBtn?.addEventListener('click', closeSuggest);
suggestModal?.addEventListener('click', e => { if (e.target === suggestModal) closeSuggest(); });

submitSuggestBtn?.addEventListener('click', async () => {
  const mon      = document.getElementById('sug-mon').value.trim();
  const burmese  = document.getElementById('sug-burmese').value.trim();
  const english  = document.getElementById('sug-english').value.trim();
  const meaning  = document.getElementById('sug-meaning').value.trim();
  const gender   = document.getElementById('sug-gender').value;
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

// ── Core conversion ───────────────────────────────────────────

async function convert() {
  const input = inputsByLang[fromLang]?.value.trim();
  if (!input) return;

  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting…';
  setStatus('Looking up…');

  wordTokensSection.classList.remove('hidden');
  wordTokensDiv.innerHTML = '<div class="spinner"></div>';
  downloadCardBtn?.classList.add('hidden');

  try {
    // Convert from the active language to the other two
    const otherLangs = LANGS.filter(l => l !== fromLang);
    const conversions = await Promise.all(
      otherLangs.map(async targetLang => {
        const data = await fetchConversion(input, fromLang, targetLang);
        return { targetLang, data };
      })
    );

    const conversionByTarget = {};
    conversions.forEach(row => { conversionByTarget[row.targetLang] = row.data; });

    // Use segments from whichever conversion gave us the most info
    const firstConv = conversions[0]?.data;
    wordResults    = firstConv?.segments || [];
    conversionMode = firstConv?.mode    || '';

    columnResults = {
      mon:     fromLang === 'mon'     ? input : (conversionByTarget.mon?.assembled     || ''),
      burmese: fromLang === 'burmese' ? input : (conversionByTarget.burmese?.assembled || ''),
      english: fromLang === 'english' ? input : (conversionByTarget.english?.assembled || ''),
    };

    // Populate the other two boxes with results
    LANGS.forEach(lang => {
      if (lang !== fromLang) {
        const el = inputsByLang[lang];
        if (el) el.value = columnResults[lang];
        colsByLang[lang]?.classList.add('input-column--result');
      } else {
        colsByLang[lang]?.classList.remove('input-column--result');
      }
    });

    const needsBreakdown = wordResults.length > 1
      || wordResults.some(wr => !wr.matched || (wr.options || []).length > 1);

    renderWordTokens();
    wordTokensSection.classList.toggle('hidden', !needsBreakdown);

    downloadCardBtn?.classList.remove('hidden');
    saveHistory(input, columnResults);
    renderHistory();
    setStatus(`Source: ${LANG_LABELS[fromLang]}`);
  } catch (e) {
    wordTokensDiv.innerHTML = `<div class="alert alert--danger">${escHtml(e.message || 'Conversion failed — please try again.')}</div>`;
    wordTokensSection.classList.remove('hidden');
    setStatus('');
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
  }
}

function markActiveColumn(lang) {
  LANGS.forEach(l => {
    const col = colsByLang[l];
    if (!col) return;
    if (l === lang) {
      col.classList.add('input-column--active');
      col.classList.remove('input-column--result');
    } else {
      col.classList.remove('input-column--active');
    }
  });
}

// ── Word tokens rendering ─────────────────────────────────────

function renderWordTokens() {
  const tokens = wordResults.map((wr, i) => renderToken(wr, i)).join('');
  wordTokensDiv.innerHTML = tokens || '';

  wordTokensDiv.querySelectorAll('.variant-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const wi = parseInt(btn.dataset.wordIndex, 10);
      const mi = parseInt(btn.dataset.matchIndex, 10);
      wordResults[wi].selectedIndex = mi;
      // Rebuild assembled results from updated selections
      rebuildFromWordTokens();
      renderWordTokens();
    });
  });
}

function rebuildFromWordTokens() {
  // Re-assemble target columns based on selected variants
  const toLang1 = LANGS.filter(l => l !== fromLang)[0];
  const toLang2 = LANGS.filter(l => l !== fromLang)[1];

  function assemble(lang) {
    return wordResults.map(wr => {
      const opts = Array.isArray(wr.options) ? wr.options : [];
      const idx  = wr.selectedIndex || 0;
      const opt  = opts[idx] || opts[0];
      return opt ? (opt[lang] || '') : (wr.source || '');
    }).join('');
  }

  if (toLang1) columnResults[toLang1] = assemble(toLang1);
  if (toLang2) columnResults[toLang2] = assemble(toLang2);

  LANGS.forEach(lang => {
    if (lang !== fromLang) {
      const el = inputsByLang[lang];
      if (el) el.value = columnResults[lang];
    }
  });
}

function renderToken(wr, i) {
  const sourceText    = wr.source || '';
  const options       = Array.isArray(wr.options) ? wr.options : [];
  const selectedIndex = wr.selectedIndex || 0;
  const srcClass      = langClass(fromLang);
  // Show the first target language in the breakdown for context
  const displayTarget = LANGS.find(l => l !== fromLang) || 'mon';
  const tgtClass      = langClass(displayTarget);

  if (options.length === 0 || !wr.matched) {
    return `<div class="word-token word-token--unknown">
      <span class="${srcClass}">${escHtml(sourceText)}</span>
      <span class="word-token__badge">not found</span>
    </div>`;
  }

  const selected = options[selectedIndex] || options[0];
  const src = selected[fromLang]     || sourceText;
  const tgt = selected[displayTarget] || sourceText;

  if (options.length === 1) {
    return `<div class="word-token word-token--single">
      <span class="${srcClass}">${escHtml(src)}</span>
      <span class="word-token__arrow">→</span>
      <span class="${tgtClass}">${escHtml(tgt)}</span>
    </div>`;
  }

  const chips = options.map((option, idx) => {
    const oSrc     = option[fromLang]      || sourceText;
    const oTgt     = option[displayTarget] || sourceText;
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

// ── Download Card (Save as Image) ─────────────────────────────

function openDownloadCard() {
  const input  = inputsByLang[fromLang]?.value.trim() || '';
  const result = columnResults.mon || columnResults.burmese || columnResults.english || '';

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop open';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Name Card</h3>
        <button class="modal__close" aria-label="Close">×</button>
      </div>
      <div class="modal__body">
        <div class="name-card-controls">
          <label class="name-card-control">
            <span>Background color</span>
            <input type="color" id="_cardBgColor" value="#1a3d2b" />
          </label>
          <label class="name-card-control">
            <span>Background image</span>
            <input type="file" id="_cardBgImage" accept="image/*" />
          </label>
          <button type="button" class="btn btn--ghost btn--sm name-card-remove-image" id="_removeCardBgImage">Remove image</button>
        </div>
        <div class="name-card-preview" id="_cardPreview">
          <div class="name-card-preview__lang">${escHtml(LANG_LABELS[fromLang])}</div>
          <div class="name-card-preview__name ${langClass(fromLang)}">${escHtml(input)}</div>
          <div class="name-card-preview__arrow">↓</div>
          <div class="name-card-preview__lang">Mon / Burmese / English</div>
          <div class="name-card-preview__name name-card-preview__accent">${escHtml(result)}</div>
        </div>
        <p class="name-card-hint">The card will be saved as a PNG image.</p>
      </div>
      <div class="modal__footer">
        <button class="btn btn--ghost" id="_closeCardBtn">Close</button>
        <button class="btn btn--primary" id="_saveCardBtn">
          <span id="_saveCardBtnLabel">⬇ Save Image</span>
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const preview         = modal.querySelector('#_cardPreview');
  const bgColorInput    = modal.querySelector('#_cardBgColor');
  const bgImageInput    = modal.querySelector('#_cardBgImage');
  const removeBgImageBtn = modal.querySelector('#_removeCardBgImage');
  let customBgImage    = '';
  let customBgImageObj = null;

  function updateCardPreview() {
    preview.style.backgroundColor  = bgColorInput.value;
    preview.style.backgroundImage  = customBgImage
      ? `linear-gradient(rgba(15, 23, 42, 0.28), rgba(15, 23, 42, 0.35)), url('${customBgImage}')`
      : '';
  }

  bgColorInput.addEventListener('input', updateCardPreview);
  bgImageInput.addEventListener('change', () => {
    const file = bgImageInput.files && bgImageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      customBgImage = reader.result || '';
      const img = new Image();
      img.onload = () => { customBgImageObj = img; };
      img.src = customBgImage;
      updateCardPreview();
    };
    reader.readAsDataURL(file);
  });

  removeBgImageBtn.addEventListener('click', () => {
    customBgImage    = '';
    customBgImageObj = null;
    bgImageInput.value = '';
    updateCardPreview();
  });

  updateCardPreview();
  modal.querySelector('.modal__close').onclick = () => modal.remove();
  modal.querySelector('#_closeCardBtn').onclick  = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#_saveCardBtn').onclick   = () => {
    saveCardAsImage(preview, bgColorInput.value, customBgImageObj, modal);
  };
}

function saveCardAsImage(previewEl, bgColor, bgImageObj, modal) {
  const saveBtn      = modal.querySelector('#_saveCardBtn');
  const saveBtnLabel = modal.querySelector('#_saveCardBtnLabel');
  saveBtnLabel.textContent = 'Saving…';
  saveBtn.disabled = true;

  const W = 600, H = 340;
  const scale = window.devicePixelRatio || 2;
  const canvas = document.createElement('canvas');
  canvas.width  = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = bgColor || '#1a3d2b';
  ctx.fillRect(0, 0, W, H);

  function drawContents() {
    if (bgImageObj) {
      const imgAspect = bgImageObj.width / bgImageObj.height;
      const canvasAspect = W / H;
      let sw, sh, sx, sy;
      if (imgAspect > canvasAspect) {
        sh = bgImageObj.height; sw = sh * canvasAspect;
        sx = (bgImageObj.width - sw) / 2; sy = 0;
      } else {
        sw = bgImageObj.width; sh = sw / canvasAspect;
        sx = 0; sy = (bgImageObj.height - sh) / 2;
      }
      ctx.drawImage(bgImageObj, sx, sy, sw, sh, 0, 0, W, H);
      const grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, 'rgba(15,23,42,0.28)');
      grd.addColorStop(1, 'rgba(15,23,42,0.45)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    }

    const cx = W / 2;
    const fromText     = previewEl.querySelector('.name-card-preview__name:not(.name-card-preview__accent)')?.textContent || '';
    const fromLangLabel = previewEl.querySelectorAll('.name-card-preview__lang')[0]?.textContent || '';
    const toText       = previewEl.querySelector('.name-card-preview__accent')?.textContent || '';
    const toLangLabel  = previewEl.querySelectorAll('.name-card-preview__lang')[1]?.textContent || '';

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 11px "DM Sans", sans-serif';
    ctx.fillText(fromLangLabel.toUpperCase(), cx, 72);

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = 'bold 36px "Padauk", "Noto Sans Mon", serif';
    ctx.fillText(fromText, cx, 118);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '24px sans-serif';
    ctx.fillText('↓', cx, 160);

    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 11px "DM Sans", sans-serif';
    ctx.fillText(toLangLabel.toUpperCase(), cx, 200);

    ctx.fillStyle = '#e8b84b';
    ctx.font = 'bold 40px "Padauk", "Noto Sans Mon", serif';
    ctx.fillText(toText, cx, 254);

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '500 12px "DM Sans", sans-serif';
    ctx.fillText('Mon Names Converter', cx, H - 22);

    try {
      const link = document.createElement('a');
      link.download = `mon-name-${(toText || 'card').replace(/\s+/g, '-').substring(0, 30)}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      alert('Could not save image. Try right-clicking the preview and saving manually.');
    }

    saveBtnLabel.textContent = '✓ Saved!';
    setTimeout(() => { saveBtnLabel.textContent = '⬇ Save Image'; saveBtn.disabled = false; }, 2000);
  }

  if (document.fonts?.ready) {
    document.fonts.ready.then(drawContents);
  } else {
    setTimeout(drawContents, 300);
  }
}

// ── Suggest modal ─────────────────────────────────────────────

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
  suggestModal.querySelector('input')?.focus();
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

// ── History ───────────────────────────────────────────────────

function saveHistory(input, result) {
  const entry = { input, result, from: fromLang, ts: Date.now() };
  history = [entry, ...history.filter(h => !(h.input === input && h.from === fromLang))].slice(0, 10);
  try { localStorage.setItem('converter-history', JSON.stringify(history)); }
  catch (e) {}
}

function renderHistory() {
  if (!historyList) return;
  if (history.length === 0) {
    historyList.innerHTML = '<p class="text-muted text-small" style="padding:var(--space-sm) 0">No recent conversions yet.</p>';
    return;
  }

  historyList.innerHTML = history.map((h, i) => {
    const result = h.result || {};
    const preview = typeof result === 'string'
      ? result
      : [result.mon, result.burmese, result.english].filter(Boolean).join(' · ');
    return `<div class="history-item" data-hi="${i}">
      <span class="history-item__from ${langClass(h.from)}">${escHtml(h.input)}</span>
      <span class="history-item__arrow">→</span>
      <span class="history-item__to">${escHtml(preview)}</span>
    </div>`;
  }).join('');

  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = history[parseInt(item.dataset.hi, 10)];
      if (!h) return;
      fromLang = h.from || 'burmese';
      const el = inputsByLang[fromLang];
      if (el) el.value = h.input;
      // Clear the other boxes before converting
      LANGS.forEach(l => { if (l !== fromLang && inputsByLang[l]) inputsByLang[l].value = ''; });
      markActiveColumn(fromLang);
      convert();
    });
  });
}

// ── Utilities ─────────────────────────────────────────────────

function clearAll() {
  LANGS.forEach(lang => {
    const el = inputsByLang[lang];
    if (el) el.value = '';
    colsByLang[lang]?.classList.remove('input-column--active', 'input-column--result');
  });
  wordResults    = [];
  conversionMode = '';
  columnResults  = { mon: '', burmese: '', english: '' };
  wordTokensSection.classList.add('hidden');
  wordTokensDiv.innerHTML = '';
  downloadCardBtn?.classList.add('hidden');
  setStatus('');
}

async function fetchConversion(input, from, to) {
  const params = new URLSearchParams({ q: input, from, to });
  const res    = await fetch(`${API_BASE}/convert?${params}`);
  const data   = await res.json();
  if (!res.ok) throw new Error(data.error || 'Conversion failed');
  return data;
}

function copyColumn(lang, btn) {
  const text = columnResults[lang] || inputsByLang[lang]?.value || '';
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
    return Promise.resolve();
  }).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }).catch(() => {});
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

// ── Theme toggle ──────────────────────────────────────────────
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
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateBtn(next);
  });
})();
