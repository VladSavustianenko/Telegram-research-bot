# Production image (TRB-100, docs/OPERATIONS.md). One image serves both deployment steps:
#   pre-deploy (migrations):  node dist/ops/migrate.js
#   start (CMD):              node dist/main.js
# Operator commands run from the same image: node dist/ops/<command>.js.
#
# Base image pinned by tag and multi-platform index digest (verified 2026-10-21 with
# `docker buildx imagetools inspect node:24.19.0-bookworm-slim`; image built 2026-08-25).
# Update both together, deliberately. No build arguments or secrets are used: Railway
# variables never reach the image.

# ---- Build: install all dependencies, generate the Prisma client, compile, prune ----
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
# OpenSSL lets Prisma detect the platform and fetch the matching schema engine
# (used by `prisma migrate deploy`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV CHECKPOINT_DISABLE=1
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
# postinstall runs `prisma generate`; no DATABASE_URL is needed for generation.
RUN npm ci --no-audit --no-fund
COPY src ./src
# Keep production dependencies only. The Prisma CLI and its engine are production
# dependencies (migrations run from this image).
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- Runtime: production dependencies, compiled output, migrations ----
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    # No Prisma update/telemetry check from production containers.
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Files stay root-owned and read-only for the process; nothing durable is written locally.
USER node
# Railway provides PORT; 3000 is the local default.
EXPOSE 3000
# Exec form: node is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["node", "dist/main.js"]
