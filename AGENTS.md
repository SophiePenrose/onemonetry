# AGENTS.md

## Cursor Cloud specific instructions

### Services

| Service | Directory | Port | Start command |
|---------|-----------|------|---------------|
| Mock Backend (Express) | `mock-backend/` | 8000 | `node mock-backend/server.js` (run from repo root) |
| Mock Backend auto-restart | `mock-backend/` | 8000 | `npm run dev` (run from `mock-backend/`) |
| Frontend (Vite + React) | `frontend/` | 5173 | `npm run dev` (run from `frontend/`) |

### Important caveats

- The **mock-backend resolves its data files relative to its own directory** (`__dirname`), so it can be started from anywhere — e.g. `node mock-backend/server.js` from the repo root, or `npm start` from inside `mock-backend/`. Override the data locations with the `COMPANIES_PATH` and `DATABASE_PATH` environment variables if needed.
- The **frontend Vite dev server** proxies `/api` requests to `http://localhost:8000`, so the mock-backend must be running before the frontend can fetch data.
- Start the backend **before** the frontend to avoid proxy errors on initial page load.
- During development, prefer `npm run dev` in `mock-backend/` so Node restarts automatically on backend file changes. Vite already hot-reloads frontend changes.
- Both services use `npm` (lockfiles are `package-lock.json`).
- There are **no lint, test, or build CI scripts** configured in either `package.json`. `npm run build` in `frontend/` runs `vite build`.
- `mock-backend/companies.json` ships as a single placeholder company — a clean slate intended for real Companies House data loaded via the import pipeline. A fuller 27-company reference dataset with varied product motions (`FX`, `Cards`, `Merchant Acquiring`, etc.) is available in `mock-backend/companies.sample.json`.
