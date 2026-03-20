# Mon Names Converter

Mon Names Converter is a Cloudflare Workers + D1 web app for searching and managing Mon, Burmese, and English name equivalents.

It includes:
- A public search interface (`/`) for multilingual name lookup.
- A public suggestion form flow (`/api/suggestions`) for community submissions.
- An admin panel (`/admin.html`) for moderation and CRUD management.
- A CSV-to-SQL seeding pipeline to keep name data maintainable.

---

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Static frontend:** HTML/CSS/Vanilla JavaScript served from `public/`
- **Tooling:** Wrangler

---

## Project Structure

```text
src/
  worker.js              # Worker routes + API handlers
public/
  index.html             # Public search UI
  app.js                 # Public UI behavior
  admin.html             # Admin UI
  admin.js               # Admin dashboard behavior
  styles.css             # Shared styles
migrations/
  0001_*.sql ...         # D1 schema and data migrations
data/
  names.csv              # Editable source data for names
scripts/
  csv-to-sql.js          # Generates seed SQL from CSV
wrangler.toml            # Worker + D1 + vars config
```

---

## Prerequisites

- Node.js 18+
- npm
- Cloudflare account
- Wrangler CLI (installed via `npm install` in this repo)

---

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a D1 database:

   ```bash
   npm run db:create
   ```

3. Update `wrangler.toml`:
   - Replace `YOUR_D1_DATABASE_ID_HERE` with your D1 `database_id`.
   - Change `ADMIN_PASSWORD` from the default value.

4. Apply migrations locally:

   ```bash
   npm run db:migrate:local
   ```

5. (Optional) Regenerate and apply seed data:

   ```bash
   npm run db:seed:local
   ```

6. Start local dev server:

   ```bash
   npm run dev
   ```

App runs at `http://localhost:8787`.

---

## Deployment

1. Ensure production D1 is configured in `wrangler.toml`.
2. Apply remote migrations:

   ```bash
   npm run db:migrate:remote
   ```

3. Set secure admin password secret in Cloudflare:

   ```bash
   wrangler secret put ADMIN_PASSWORD
   ```

4. Deploy worker:

   ```bash
   npm run deploy
   ```

---

## Available npm Scripts

- `npm run dev` — Run worker locally.
- `npm run deploy` — Deploy worker.
- `npm run db:create` — Create D1 database.
- `npm run db:migrate:local` — Apply migrations locally.
- `npm run db:migrate:remote` — Apply migrations remotely.
- `npm run db:seed:generate` — Generate `migrations/0004_seed_names.sql` from CSV.
- `npm run db:seed:local` — Generate seed SQL + apply local migrations.
- `npm run db:seed:remote` — Generate seed SQL + apply remote migrations.
- `npm run db:studio` — Quick query to inspect local DB.
- `npm run db:reset:local` — Drop and rebuild local DB tables.

---

## API Overview

### Public Endpoints

- `GET /api/convert?q=<full-name>&from=<mon|burmese|english>&to=<mon|burmese|english>`
- `GET /api/search?q=<query>&lang=<all|mon|burmese|english>`
- `POST /api/suggestions`

### Admin Endpoints

Authenticated via `admin_session` HttpOnly cookie.

- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/stats`
- `GET /api/admin/names?page=<n>`
- `POST /api/admin/names`
- `PUT /api/admin/names/:id`
- `DELETE /api/admin/names/:id`
- `GET /api/admin/suggestions?status=<pending|approved|rejected>`
- `PUT /api/admin/suggestions/:id`

---

## Data Workflow

1. Edit `data/names.csv`.
2. Generate SQL migration seed:

   ```bash
   npm run db:seed:generate
   ```

3. Apply migrations (`db:migrate:local` or `db:migrate:remote`).

This keeps source data human-editable while preserving reproducible SQL migrations.

---

## Security Notes

- Do **not** deploy with plaintext `ADMIN_PASSWORD` in `wrangler.toml`.
- Prefer `wrangler secret put ADMIN_PASSWORD` for production.
- Admin routes rely on cookie-based session auth; enforce HTTPS in production.

---

## License

Not open-source.
