FROM node:22-slim

WORKDIR /app

COPY mock-backend/package.json mock-backend/package-lock.json ./mock-backend/
RUN cd mock-backend && npm ci --production

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

COPY mock-backend/ ./mock-backend/
COPY frontend/ ./frontend/

RUN cd frontend && npm run build

EXPOSE 8000

ENV NODE_ENV=production

CMD ["node", "mock-backend/server.js"]
