# AGENTS.md

## Cursor Cloud specific instructions

### Services

| Service | Directory | Port | Start command |
|---------|-----------|------|---------------|
| Mock Backend (Express) | `mock-backend/` | 8000 | `node mock-backend/server.js` (run from repo root) |
| Frontend (Vite + React) | `frontend/` | 5173 | `npm run dev` (run from `frontend/`) |

### Important caveats

- The **mock-backend must be started from the repo root** (`/workspace`), not from inside `mock-backend/`. It resolves `companies.json` via `path.join(process.cwd(), "mock-backend", "companies.json")`.
- The **frontend Vite dev server** proxies `/api` requests to `http://localhost:8000`, so the mock-backend must be running before the frontend can fetch data.
- Start the backend **before** the frontend to avoid proxy errors on initial page load.
- Both services use `npm` (lockfiles are `package-lock.json`).
- **Lint:** `npm run lint` in both `mock-backend/` and `frontend/` (ESLint). Warnings only, no errors expected.
- **Tests:** `npm test` in `frontend/` runs vitest. `npm test` in `mock-backend/` requires the server to be running first (tests make HTTP requests to localhost:8000). There is 1 pre-existing frontend test failure (`CompetitorPanel` empty-state text mismatch).
- **Build:** `npm run build` in `frontend/` runs `vite build`.
- The mock data lives in `mock-backend/companies.json`. On PR #7+ the auto-pull feature also ingests Companies House bulk data into SQLite (`onemonetry.db`, auto-created).
