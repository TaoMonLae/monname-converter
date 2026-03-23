import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function createDbMock(handler) {
  return {
    calls: [],
    prepare(sql) {
      return {
        bind: (...args) => ({
          all: async () => {
            const result = await handler({ sql, args, op: 'all' });
            return result ?? { results: [] };
          },
          first: async () => {
            const result = await handler({ sql, args, op: 'first' });
            return result ?? null;
          },
          run: async () => {
            this.calls.push({ sql, args, op: 'run' });
            const result = await handler({ sql, args, op: 'run' });
            return result ?? { success: true, meta: {} };
          },
        }),
      };
    },
  };
}

const workerSourcePath = path.resolve('src/worker.js');
const workerSource = fs.readFileSync(workerSourcePath, 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
const testableWorkerPath = path.join(tempDir, 'worker.testable.mjs');
fs.writeFileSync(
  testableWorkerPath,
  `${workerSource}\nexport { handleConvert, buildAssembled, handleUpdateSuggestion, handleAdminStructuredJsonExport, handleAdminStructuredJsonImport, handleUpdateName };\n`,
  'utf8'
);
const workerModule = await import(pathToFileURL(testableWorkerPath).href);

const { handleConvert, buildAssembled, handleUpdateSuggestion, handleAdminStructuredJsonExport, handleAdminStructuredJsonImport, handleUpdateName } = workerModule;

test('exact full-name match flow returns exact_name mode', async () => {
  const db = createDbMock(({ sql, op }) => {
    if (op === 'all' && sql.includes('FROM names') && sql.includes('WHERE english = ?')) {
      return {
        results: [{
          id: 1,
          mon: 'မန်အမည်',
          burmese: 'ဗမာအမည်',
          english: 'Test Name',
          meaning: 'meaning',
          verified: 1,
        }],
      };
    }

    return { results: [] };
  });

  const request = new Request('https://example.com/api/convert?q=Test%20Name&from=english&to=mon');
  const response = await handleConvert(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.mode, 'exact_name');
  assert.equal(payload.assembled, 'မန်အမည်');
  assert.equal(payload.segments.length, 1);
  assert.equal(payload.segments[0].source, 'Test Name');
});

test('exact alias match flow returns alias_name mode', async () => {
  const db = createDbMock(({ sql, op }) => {
    if (op === 'all' && sql.includes('FROM names') && sql.includes('WHERE english = ?')) {
      return { results: [] };
    }

    if (op === 'all' && sql.includes('FROM aliases a') && sql.includes('a.language = ? AND a.alias = ?')) {
      return {
        results: [{
          id: 5,
          mon: 'အယ်လီယပ်',
          burmese: 'နာမည်ပုံမှန်',
          english: 'Canonical',
          meaning: 'alias meaning',
          verified: 1,
        }],
      };
    }

    return { results: [] };
  });

  const request = new Request('https://example.com/api/convert?q=Alias%20Value&from=english&to=mon');
  const response = await handleConvert(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.mode, 'alias_name');
  assert.equal(payload.assembled, 'အယ်လီယပ်');
  assert.equal(payload.segments[0].source, 'Alias Value');
});

test('exact full-name match includes output variants and selects preferred by default', async () => {
  const db = createDbMock(({ sql, op, args }) => {
    if (op === 'all' && sql.includes('FROM names') && sql.includes('WHERE mon = ?')) {
      return {
        results: [{
          id: 21,
          mon: 'အံၚ်',
          burmese: 'အောင်',
          english: 'Aung',
          meaning: null,
          verified: 1,
        }],
      };
    }

    if (op === 'all' && sql.includes('FROM name_output_variants')) {
      assert.equal(args[0], 'english');
      return {
        results: [
          { id: 1, name_id: 21, target_lang: 'english', target_text: 'Ong', preferred: 0, verified: 1, label: null, notes: null },
          { id: 2, name_id: 21, target_lang: 'english', target_text: 'Oung', preferred: 0, verified: 1, label: null, notes: null },
          { id: 3, name_id: 21, target_lang: 'english', target_text: 'Aung', preferred: 1, verified: 1, label: 'default', notes: null },
        ],
      };
    }

    return { results: [] };
  });

  const request = new Request('https://example.com/api/convert?q=%E1%80%A1%E1%80%B6%E1%81%9A%E1%80%BA&from=mon&to=english');
  const response = await handleConvert(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.mode, 'exact_name');
  assert.equal(payload.segments[0].options.length, 3);
  assert.equal(payload.segments[0].options[0].english, 'Aung');
  assert.equal(payload.assembled, 'Aung');
});

test('segmented fallback flow composes output from partial matches', async () => {
  const translations = {
    'ka, la': [{ source_text: 'ka', mon: 'ကာ', burmese: 'ကာ', english: 'ka', meaning: null, verified: 1, preferred: 1 }],
    'la': [{ source_text: 'la', mon: 'လာ', burmese: 'လာ', english: 'la', meaning: null, verified: 1, preferred: 1 }],
  };

  const db = createDbMock(({ sql, args, op }) => {
    if (op !== 'all') return null;

    if (sql.includes('FROM names') && sql.includes('WHERE english = ?')) {
      return { results: [] };
    }

    if (sql.includes('FROM aliases a') && sql.includes('a.language = ? AND a.alias = ?')) {
      return { results: [] };
    }

    if (sql.includes('FROM names') && sql.includes('substr(?, 1, length(english)) = english')) {
      return { results: translations[args[0]] ?? [] };
    }

    if (sql.includes('FROM aliases a') && sql.includes('substr(?, 1, length(a.alias)) = a.alias')) {
      return { results: [] };
    }

    if (sql.includes('FROM segments s')) {
      return { results: [] };
    }

    return { results: [] };
  });

  const request = new Request('https://example.com/api/convert?q=ka,%20la&from=english&to=mon');
  const response = await handleConvert(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.mode, 'segmented');
  assert.equal(payload.assembled, 'ကာ, လာ');
  assert.ok(payload.segments.some(segment => segment.matched === false), 'expected unmatched separator segment');
});

test('separator preservation logic keeps separatorBefore while rebuilding segmented output', () => {
  const assembled = buildAssembled([
    {
      separatorBefore: '',
      selectedIndex: 0,
      fromLang: 'english',
      source: 'ka',
      options: [{ mon: 'ကာ', english: 'ka' }],
    },
    {
      separatorBefore: ', ',
      selectedIndex: 0,
      fromLang: 'english',
      source: 'la',
      options: [{ mon: 'လာ', english: 'la' }],
    },
  ], 'mon');

  assert.equal(assembled, 'ကာ, လာ');
});

test('duplicate-safe suggestion approval does not re-promote approved suggestion', async () => {
  const db = createDbMock(({ sql, op }) => {
    if (op === 'first' && sql.includes('SELECT * FROM suggestions WHERE id = ?')) {
      return {
        id: 9,
        status: 'approved',
        approved_name_id: 42,
      };
    }

    return null;
  });

  const request = new Request('https://example.com/api/admin/suggestions/9', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', admin_notes: 'no-op reapprove' }),
  });

  const response = await handleUpdateSuggestion(request, { DB: db }, 9);
  const payload = await response.json();

  assert.equal(payload.success, true);
  assert.equal(payload.alreadyApproved, true);
  assert.equal(payload.nameId, 42);

  const promotedRuns = db.calls.filter(call => call.sql.includes('INSERT INTO names'));
  assert.equal(promotedRuns.length, 0);
});

test('structured json export returns versioned payload for names scope', async () => {
  const db = createDbMock(({ sql, op }) => {
    if (op !== 'all') return { results: [] };
    if (sql.includes('FROM names n')) {
      return {
        results: [{
          id: 1,
          mon: 'အံၚ်',
          burmese: 'အောင်',
          english: 'Aung',
          meaning: 'victory',
          gender: 'neutral',
          verified: 1,
          aliases: JSON.stringify([{ alias: 'Ong', language: 'english' }]),
          output_variants: JSON.stringify([{ target_lang: 'english', target_text: 'Aung', preferred: 1, verified: 1, label: 'Recommended', notes: '' }]),
        }],
      };
    }
    return { results: [] };
  });

  const response = await handleAdminStructuredJsonExport(
    new Request('https://example.com/api/admin/export/json?scope=names'),
    { DB: db }
  );
  const payload = await response.json();

  assert.equal(payload.schema_version, '1.0');
  assert.equal(Array.isArray(payload.data.names), true);
  assert.equal(payload.data.names.length, 1);
  assert.equal(payload.data.names[0].output_variants.english[0].text, 'Aung');
  assert.equal(payload.data.segments.length, 0);
});

test('structured json import dryRun validates and summarizes', async () => {
  const db = createDbMock(({ op }) => (op === 'all' ? { results: [] } : null));

  const request = new Request('https://example.com/api/admin/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge',
      dryRun: true,
      payload: {
        schema_version: '1.0',
        data: {
          names: [{
            mon: 'အံၚ်',
            english: 'Aung',
            input_aliases: { english: ['Aung', 'Ong'] },
            output_variants: {
              english: [{ text: 'Aung', preferred: true, verified: true }],
            },
          }],
          segments: [{
            source_text: 'အံၚ်',
            source_lang: 'mon',
            output_variants: {
              english: [{ text: 'Aung', preferred: true, verified: true }],
            },
          }],
        },
      },
    }),
  });

  const response = await handleAdminStructuredJsonImport(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.success, true);
  assert.equal(payload.summary.dry_run, true);
  assert.equal(payload.summary.names_inserted, 1);
  assert.equal(payload.summary.segments_inserted, 1);
  assert.equal(payload.summary.aliases_inserted, 2);
  assert.equal(payload.summary.output_variants_inserted, 1);
  assert.equal(payload.summary.segment_variants_inserted, 1);
  assert.equal(payload.summary.invalid_records, 0);
});


test('segmented match includes multiple output variants and picks preferred by default', async () => {
  const db = createDbMock(({ sql, args, op }) => {
    if (op !== 'all') return null;

    if (sql.includes('FROM names') && sql.includes('WHERE english = ?')) return { results: [] };
    if (sql.includes('FROM aliases a') && sql.includes('a.language = ? AND a.alias = ?')) return { results: [] };
    if (sql.includes('FROM names') && sql.includes('substr(?, 1, length(english)) = english')) return { results: [] };
    if (sql.includes('FROM aliases a') && sql.includes('substr(?, 1, length(a.alias)) = a.alias')) return { results: [] };

    if (sql.includes('FROM segments s')) {
      if (args[2] === 'ka') {
        return {
          results: [
            { source_text: 'ka', target_text: 'ကာ', meaning: 'first', verified: 1, preferred: 1 },
            { source_text: 'ka', target_text: 'ခါ', meaning: 'alt', verified: 1, preferred: 0 },
          ],
        };
      }
      return { results: [] };
    }

    return { results: [] };
  });

  const request = new Request('https://example.com/api/convert?q=ka&from=english&to=mon');
  const response = await handleConvert(request, { DB: db });
  const payload = await response.json();

  assert.equal(payload.mode, 'segmented');
  assert.equal(payload.segments.length, 1);
  assert.equal(payload.segments[0].options.length, 2);
  assert.equal(payload.segments[0].selectedIndex, 0);
  assert.equal(payload.assembled, 'ကာ');
});

test('rebuilding assembled output reflects changed selected variant', () => {
  const segments = [{
    separatorBefore: '',
    selectedIndex: 0,
    fromLang: 'english',
    source: 'aung',
    options: [
      { english: 'Aung', mon: 'အံၚ်' },
      { english: 'Ong', mon: 'အောင်' },
      { english: 'Oung', mon: 'အိုင်' },
    ],
  }];

  assert.equal(buildAssembled(segments, 'english'), 'Aung');
  segments[0].selectedIndex = 2;
  assert.equal(buildAssembled(segments, 'english'), 'Oung');
});

test('admin update name persists output variants payload', async () => {
  const db = createDbMock(({ sql, op }) => {
    if (op === 'run') return { success: true, meta: {} };
    if (op === 'first') return { id: 1 };
    return { results: [] };
  });

  const request = new Request('https://example.com/api/admin/names/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mon: 'အံၚ်',
      burmese: 'အောင်',
      english: 'Aung',
      meaning: 'victory',
      gender: 'neutral',
      verified: true,
      aliases: [],
      output_variants: [
        { target_lang: 'english', target_text: 'Aung', preferred: true, verified: true, label: 'Recommended', notes: '' },
        { target_lang: 'english', target_text: 'Ong', preferred: false, verified: true, label: 'Alternate', notes: 'regional' },
      ],
    }),
  });

  const response = await handleUpdateName(request, { DB: db }, 1);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);

  const insertCalls = db.calls.filter(call => call.sql.includes('INSERT OR IGNORE INTO name_output_variants'));
  assert.equal(insertCalls.length, 2);
  assert.deepEqual(insertCalls[0].args.slice(1, 4), ['english', 'Aung', 1]);
  assert.deepEqual(insertCalls[1].args.slice(1, 4), ['english', 'Ong', 0]);
});
