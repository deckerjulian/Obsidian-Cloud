# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine

RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

# Copy the whole monorepo (simple, cache-friendly enough for small teams;
# Phase 6 can split this into deps/build stages for smaller images).
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @oc/shared build \
  && pnpm --filter @oc/backend prisma:generate \
  && pnpm --filter @oc/backend build

ENV NODE_ENV=production
WORKDIR /app/packages/backend

# Apply committed migrations, then start the server.
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main.js"]
