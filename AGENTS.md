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
- Available scripts per service:
  - **mock-backend**: `npm run lint` (eslint), `npm run test` (node --test — **integration tests that require the server to be running on port 8000**).
  - **frontend**: `npm run lint` (eslint), `npm run test` (vitest run), `npm run build` (vite build), `npm run dev` (vite dev server).
- The mock-backend tests are **integration tests** — they call `fetch` against `http://localhost:8000`, so you must start the backend server before running `npm run test` in `mock-backend/`.
- The frontend test suite has 1 pre-existing failure (`CompetitorPanel > renders empty state` — text mismatch between test and component). 12 of 13 tests pass.
- The mock data has 3 companies in `mock-backend/companies.json` with two product motions: `FX` and `Cards`.
