# Build from the repository root. No local database or credentials enter the image.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend-build
# better-sqlite3 can fall back to a native build when a prebuilt binary is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend/ ./

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DEMO=1 \
    PUBLIC_AI_ENABLED=0 \
    DB_MODE=cloudbase \
    STATIC_DIR=/app/frontend/dist
WORKDIR /app
COPY --from=backend-build --chown=node:node /app/backend/ ./backend/
COPY --from=frontend-build --chown=node:node /build/frontend/dist/ ./frontend/dist/
RUN mkdir -p /app/backend/data && chown node:node /app/backend/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "backend/src/index.js"]
