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
- There are **no lint, test, or build CI scripts** configured in either `package.json`. `npm run build` in `frontend/` runs `vite build`.
- The mock data has 3 companies in `mock-backend/companies.json` with two product motions: `FX` and `Cards`.
