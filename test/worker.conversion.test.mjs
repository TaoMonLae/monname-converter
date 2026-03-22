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
  `${workerSource}\nexport { handleConvert, buildAssembled, handleUpdateSuggestion };\n`,
  'utf8'
);
const workerModule = await import(pathToFileURL(testableWorkerPath).href);

const { handleConvert, buildAssembled, handleUpdateSuggestion } = workerModule;

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
