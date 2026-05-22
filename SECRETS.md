# Secrets and API keys

Do not commit real API keys to this repository.

## Required keys

- `OPENAI_API_KEY`: enables rich filing analysis, stakeholder review, email generation, and richer scoring.
- `COMPANIES_HOUSE_API_KEY`: enables live Companies House name/status lookups.

## Local development

1. Copy `.env.example` to `.env`.
2. Replace the placeholder values in `.env`.
3. Start the app with `./start.sh`, or run:
   - Backend: `cd mock-backend && npm run dev`
   - Frontend: `cd frontend && npm run dev`

The `.env` file is ignored by Git, so it will not be pushed.

## GitHub / deployed environments

Add the same names as encrypted environment variables/secrets in the place that runs the app:

- GitHub repository secrets if a GitHub Action deploys the app.
- Your hosting provider's environment variables if the app is deployed elsewhere.
- Docker Compose host environment variables if running with `docker compose`.

Once configured in the deployment environment, the app reads them automatically on every publish/restart. You should not need to re-enter them manually for each deployment unless the hosting environment is recreated without its secrets.

## Cursor Cloud agents

Do not paste real API keys into chat. Instead, configure them in the environment used to start agents/services. The app expects the variables above to exist in the process environment or in a local `.env` file.
