# syntax=docker/dockerfile:1

# ---- Build: install all dependencies, generate Prisma client, compile ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
# postinstall runs `prisma generate`; no DATABASE_URL is needed for generation.
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

# ---- Runtime: production dependencies and compiled output only ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
USER node
# Railway provides PORT; 3000 is the local default.
EXPOSE 3000
CMD ["node", "dist/main.js"]
