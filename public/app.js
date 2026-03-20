const API_BASE = '/api';

const LANG_LABELS = { burmese: 'Burmese', mon: 'Mon', english: 'English' };
const LANGS = ['burmese', 'mon', 'english'];

let fromLang = 'burmese';
let toLang = 'mon';
let wordResults = [];
let conversionMode = '';
let columnResults = { mon: '', burmese: '', english: '' };
let history = [];

try { history = JSON.parse(localStorage.getItem('converter-history') || '[]'); }
catch (e) { history = []; }

const nameInput = document.getElementById('nameInput');
const clearBtn = document.getElementById('clearBtn');
const convertBtn = document.getElementById('convertBtn');
const wordTokensSection = document.getElementById('wordTokensSection');
const wordTokensDiv = document.getElementById('wordTokens');
const resultSection = document.getElementById('resultSection');
const resultMonEl = document.getElementById('resultMon');
const resultBurmeseEl = document.getElementById('resultBurmese');
const resultEnglishEl = document.getElementById('resultEnglish');
const nameVariantSection = null;
const nameVariantList = null;
const copyMonBtn = document.getElementById('copyMonBtn');
const copyBurmeseBtn = document.getElementById('copyBurmeseBtn');
const copyEnglishBtn = document.getElementById('copyEnglishBtn');
const downloadCardBtn = document.getElementById('downloadCardBtn');
const suggestWordBtn = document.getElementById('suggestWordBtn');
const historyList = document.getElementById('historyList');
const converterStatus = document.getElementById('converterStatus');

const suggestModal = document.getElementById('suggestModal');
const closeSuggestModal = document.getElementById('closeSuggestModal');
const cancelSuggestBtn = document.getElementById('cancelSuggestBtn');
const submitSuggestBtn = document.getElementById('submitSuggestBtn');
const suggestAlert = document.getElementById('suggestAlert');

renderHistory();
setTimeout(() => { converterStatus.textContent = ''; }, 400);

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); convert(); }
});

clearBtn.addEventListener('click', clearAll);
convertBtn.addEventListener('click', convert);

copyMonBtn?.addEventListener('click', () => copyColumn('mon', copyMonBtn));
copyBurmeseBtn?.addEventListener('click', () => copyColumn('burmese', copyBurmeseBtn));
copyEnglishBtn?.addEventListener('click', () => copyColumn('english', copyEnglishBtn));

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
    const detected = await detectBestSource(input);
    fromLang = detected.fromLang;
    const conversions = await Promise.all(
      LANGS.filter(lang => lang !== fromLang).map(async targetLang => {
        const data = await fetchConversion(input, fromLang, targetLang);
        return { targetLang, data };
      })
    );

    const conversionByTarget = {};
    conversions.forEach(row => { conversionByTarget[row.targetLang] = row.data; });
    wordResults = detected.data.segments || [];
    conversionMode = detected.data.mode || '';

    columnResults = {
      mon: fromLang === 'mon' ? input : (conversionByTarget.mon?.assembled || input),
      burmese: fromLang === 'burmese' ? input : (conversionByTarget.burmese?.assembled || input),
      english: fromLang === 'english' ? input : (conversionByTarget.english?.assembled || input),
    };

    const needsBreakdown = wordResults.length > 1 || wordResults.some(wr => !wr.matched || (wr.options || []).length > 1);
    renderWordTokens();
    renderResult();
    wordTokensSection.classList.toggle('hidden', !needsBreakdown);

    downloadCardBtn.classList.remove('hidden');
    saveHistory(input, columnResults);
    renderHistory();
    setStatus(`Detected source: ${LANG_LABELS[fromLang]}`);
  } catch (e) {
    wordTokensDiv.innerHTML = `<div class="alert alert--danger">${escHtml(e.message || 'Conversion failed — please try again.')}</div>`;
    wordTokensSection.classList.remove('hidden');
    setStatus('');
  } finally {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
  }
}

function getResultText() {
  return [columnResults.mon, columnResults.burmese, columnResults.english].filter(Boolean).join(' | ');
}

function renderResult() {
  if (resultMonEl) resultMonEl.textContent = columnResults.mon || '';
  if (resultBurmeseEl) resultBurmeseEl.textContent = columnResults.burmese || '';
  if (resultEnglishEl) resultEnglishEl.textContent = columnResults.english || '';

  resultSection.classList.remove('hidden');
}

function renderNameVariants() {
  if (!nameVariantSection || !nameVariantList) return;
  const showVariants = wordResults.length === 1
    && wordResults[0].matched
    && Array.isArray(wordResults[0].options)
    && wordResults[0].options.length > 1
    && (conversionMode === 'exact_name' || conversionMode === 'alias_name');

  if (!showVariants) {
    nameVariantSection.classList.add('hidden');
    nameVariantList.innerHTML = '';
    return;
  }

  const wr = wordResults[0];
  const selectedIndex = wr.selectedIndex || 0;
  const srcClass = langClass(fromLang);
  const tgtClass = langClass(toLang);

  nameVariantList.innerHTML = wr.options.map((option, idx) => {
    const src = option[fromLang] || wr.source || '';
    const tgt = option[toLang] || wr.source || '';
    const meaning = option.meaning ? ` — ${String(option.meaning).substring(0, 50)}` : '';
    return `<button
      type="button"
      class="name-variant-btn${idx === selectedIndex ? ' active' : ''}"
      data-variant-index="${idx}">
      <span class="name-variant-btn__target ${tgtClass}">${escHtml(tgt)}</span>
      <span class="name-variant-btn__source ${srcClass}">${escHtml(src)}</span>
      ${meaning ? `<span class="name-variant-btn__meaning">${escHtml(meaning)}</span>` : ''}
    </button>`;
  }).join('');

  nameVariantList.querySelectorAll('.name-variant-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.variantIndex, 10);
      wordResults[0].selectedIndex = idx;
      renderNameVariants();
      renderResult();
      saveHistory(nameInput.value.trim(), getResultText());
    });
  });

  nameVariantSection.classList.remove('hidden');
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

// ── Download Card (Save as Image) ─────────────────────────────

function openDownloadCard() {
  const input = nameInput.value.trim();
  const result = columnResults[toLang] || columnResults.mon || '';

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
          <div class="name-card-preview__lang">${escHtml(LANG_LABELS[toLang])}</div>
          <div class="name-card-preview__name ${langClass(toLang)} name-card-preview__accent">${escHtml(result)}</div>
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
  const preview = modal.querySelector('#_cardPreview');
  const bgColorInput = modal.querySelector('#_cardBgColor');
  const bgImageInput = modal.querySelector('#_cardBgImage');
  const removeBgImageBtn = modal.querySelector('#_removeCardBgImage');
  let customBgImage = '';
  let customBgImageObj = null;

  function updateCardPreview() {
    preview.style.backgroundColor = bgColorInput.value;
    preview.style.backgroundImage = customBgImage
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
    customBgImage = '';
    customBgImageObj = null;
    bgImageInput.value = '';
    updateCardPreview();
  });

  updateCardPreview();
  modal.querySelector('.modal__close').onclick = () => modal.remove();
  modal.querySelector('#_closeCardBtn').onclick = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#_saveCardBtn').onclick = () => {
    saveCardAsImage(preview, bgColorInput.value, customBgImageObj, modal);
  };
}

function saveCardAsImage(previewEl, bgColor, bgImageObj, modal) {
  const saveBtn = modal.querySelector('#_saveCardBtn');
  const saveBtnLabel = modal.querySelector('#_saveCardBtnLabel');
  saveBtnLabel.textContent = 'Saving…';
  saveBtn.disabled = true;

  // Card dimensions (fixed size for consistent output)
  const W = 600;
  const H = 340;
  const scale = window.devicePixelRatio || 2;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Draw background
  ctx.fillStyle = bgColor || '#1a3d2b';
  ctx.fillRect(0, 0, W, H);

  function drawContents() {
    // Overlay gradient if bg image
    if (bgImageObj) {
      // Draw image cover
      const imgAspect = bgImageObj.width / bgImageObj.height;
      const canvasAspect = W / H;
      let sw, sh, sx, sy;
      if (imgAspect > canvasAspect) {
        sh = bgImageObj.height;
        sw = sh * canvasAspect;
        sx = (bgImageObj.width - sw) / 2;
        sy = 0;
      } else {
        sw = bgImageObj.width;
        sh = sw / canvasAspect;
        sx = 0;
        sy = (bgImageObj.height - sh) / 2;
      }
      ctx.drawImage(bgImageObj, sx, sy, sw, sh, 0, 0, W, H);
      // Dark overlay
      const grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, 'rgba(15,23,42,0.28)');
      grd.addColorStop(1, 'rgba(15,23,42,0.45)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
    }

    const cx = W / 2;
    const fromText = previewEl.querySelector(`.name-card-preview__name:first-of-type`)?.textContent || '';
    const fromLangLabel = previewEl.querySelectorAll('.name-card-preview__lang')[0]?.textContent || '';
    const toText = previewEl.querySelector('.name-card-preview__accent')?.textContent || '';
    const toLangLabel = previewEl.querySelectorAll('.name-card-preview__lang')[1]?.textContent || '';

    // From lang label
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 11px "DM Sans", sans-serif';
    ctx.letterSpacing = '2px';
    ctx.fillText(fromLangLabel.toUpperCase(), cx, 72);

    // From name
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = 'bold 36px "Padauk", "Noto Sans Mon", serif';
    ctx.fillText(fromText, cx, 118);

    // Arrow
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '24px sans-serif';
    ctx.fillText('↓', cx, 160);

    // To lang label
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 11px "DM Sans", sans-serif';
    ctx.fillText(toLangLabel.toUpperCase(), cx, 200);

    // To name (accent color)
    ctx.fillStyle = '#e8b84b';
    ctx.font = 'bold 40px "Padauk", "Noto Sans Mon", serif';
    ctx.fillText(toText, cx, 254);

    // Footer branding
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '500 12px "DM Sans", sans-serif';
    ctx.fillText('Mon Names Converter', cx, H - 22);

    // Save
    try {
      const link = document.createElement('a');
      const filename = `mon-name-${(toText || 'card').replace(/\s+/g, '-').substring(0, 30)}.png`;
      link.download = filename;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      alert('Could not save image. Try right-clicking the preview and saving it manually.');
    }

    saveBtnLabel.textContent = '✓ Saved!';
    setTimeout(() => {
      saveBtnLabel.textContent = '⬇ Save Image';
      saveBtn.disabled = false;
    }, 2000);
  }

  // Ensure fonts are loaded before drawing
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(drawContents);
  } else {
    setTimeout(drawContents, 300);
  }
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
  const entry = { input, result, from: fromLang, to: 'all', ts: Date.now() };
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

  historyList.innerHTML = history.map((h, i) => `
    <div class="history-item" data-hi="${i}">
      <span class="history-item__from ${langClass(h.from)}">${escHtml(h.input)}</span>
      <span class="history-item__arrow">→</span>
      <span class="history-item__to">${escHtml(typeof h.result === 'string' ? h.result : ((h.result && h.result.mon) || ''))}</span>
    </div>`).join('');

  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = history[parseInt(item.dataset.hi, 10)];
      if (!h) return;

      nameInput.value = h.input;
      convert();
    });
  });
}

function clearAll() {
  nameInput.value = '';
  wordResults = [];
  conversionMode = '';
  columnResults = { mon: '', burmese: '', english: '' };
  wordTokensSection.classList.add('hidden');
  wordTokensDiv.innerHTML = '';
  resultSection.classList.add('hidden');
  downloadCardBtn.classList.add('hidden');
  setStatus('');
}

function matchScore(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  return segments.reduce((sum, s) => sum + (s.matched ? (s.source || '').length : 0), 0);
}

async function fetchConversion(input, from, to) {
  const params = new URLSearchParams({ q: input, from, to });
  const res = await fetch(`${API_BASE}/convert?${params}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Conversion failed');
  return data;
}

async function detectBestSource(input) {
  const candidates = await Promise.all(LANGS.map(async lang => {
    const fallbackTarget = lang === 'mon' ? 'burmese' : 'mon';
    const data = await fetchConversion(input, lang, fallbackTarget);
    return { fromLang: lang, data, score: matchScore(data) };
  }));

  candidates.sort((a, b) =>
    b.score - a.score
    || (b.data.segments?.length || 0) - (a.data.segments?.length || 0)
  );
  return candidates[0];
}

function copyColumn(lang, btn) {
  const text = columnResults[lang];
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
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }).catch(() => {});
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
