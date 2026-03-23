# JSON Import / Export Schema (v1.0)

This project supports structured JSON backup/import via admin endpoints.

## Endpoints

- `GET /api/admin/export/json?scope=names`
- `GET /api/admin/export/json?scope=segments`
- `GET /api/admin/export/json?scope=all`
- `POST /api/admin/import/json`

## Top-level format

```json
{
  "schema_version": "1.0",
  "exported_at": "2026-03-23T00:00:00.000Z",
  "source": "monname-converter",
  "data": {
    "names": [],
    "segments": []
  }
}
```

## Names model

Each `data.names[]` record:

- `mon`, `burmese`, `english`: optional strings (at least one required)
- `meaning`: optional string
- `gender`: `male | female | neutral`
- `verified`: boolean
- `input_aliases`: object of language arrays (`mon|burmese|english`) containing alias strings
- `output_variants`: object of language arrays where each item is:
  - `text` (required)
  - `preferred` (boolean)
  - `verified` (boolean)
  - `label` (optional string)
  - `notes` (optional string)

### `input_aliases` vs `output_variants`

- **input_aliases** are used for matching incoming user text (lookup keys).
- **output_variants** are used for selectable rendered output text for a target language.

## Segments model

Each `data.segments[]` record:

- `source_text` (required)
- `source_lang` (`mon|burmese|english`, required)
- `meaning` (optional)
- `verified` (boolean)
- `output_variants`: object keyed by target language; each item supports:
  - `text` (required)
  - `preferred` (boolean)
  - `verified` (boolean)
  - `notes` (optional)

> Segment output variants cannot target the same language as `source_lang`.

## Import request format

```json
{
  "mode": "merge",
  "dryRun": true,
  "payload": { "schema_version": "1.0", "data": { "names": [], "segments": [] } }
}
```

### Import modes

- `merge`: upsert matching records, keep other existing DB rows.
- `insert_only`: insert new records only, skip matches.
- `replace_all`: remove names/aliases/output variants and segments/segment variants first, then insert payload.

### dryRun

- `dryRun: true` performs validation/normalization and returns counts **without writing to D1**.
- `dryRun: false` applies the selected import mode.

## Validation highlights

Import validation includes:

- required `schema_version`
- valid language names
- required fields (`source_text`, `source_lang`, and at least one of `mon|burmese|english` for names)
- duplicate aliases and duplicate output variants (deduped with warnings)
- one preferred variant per language (auto-normalized if missing/multiple)
- field length limits and safe whitespace normalization

## Response summary fields

`POST /api/admin/import/json` returns summary counters such as:

- `names_inserted`, `names_updated`, `names_skipped`
- `aliases_inserted`
- `output_variants_inserted`
- `segments_inserted`, `segments_updated`, `segments_skipped`
- `segment_variants_inserted`
- `invalid_records`

Warnings and invalid record details are included in the response body.
