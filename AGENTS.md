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
- Both services define `lint` and `test` scripts in their `package.json`. The frontend additionally defines `build`/`dev`/`preview` (`npm run build` runs `vite build`), while the backend defines `start`/`dev` (no backend build step). `npm test` runs `vitest run` (frontend) and `node --test __tests__/*.test.js` (backend).
- **CI:** every pull request and every push to `main` runs `.github/workflows/ci.yml` (Node 22) — a `Backend (mock-backend tests)` job (`npm ci` + `npm test`) and a `Frontend (build + tests)` job (`npm ci` + `npm run build` + `npm test`). To make CI a hard merge gate, enable branch protection on `main` requiring those two checks (see the README "Continuous integration" section).
- `mock-backend/companies.json` ships as a single placeholder company — a clean slate intended for real Companies House data loaded via the import pipeline. A fuller 27-company reference dataset with varied product motions (`FX`, `Cards`, `Merchant Acquiring`, etc.) is available in `mock-backend/companies.sample.json`.
