# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
# Playwright does not support Alpine/musl. Chromium and the fonts used by the
# Arabic letterhead need a glibc base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openssl \
       ca-certificates \
       fonts-urw-base35 \
       fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Build stage: also used by the `migrate` compose service (has prisma CLI).
# ---------------------------------------------------------------------------
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
# @prisma/client declares the Prisma CLI as an optional peer, so npm installs the
# CLI (and its engine/fetch tooling) even with --omit=dev. The running API only
# needs @prisma/client and the generated .prisma client; keep the migrate CLI in
# the build stage, where the compose `migrate` service uses it.
RUN npm ci --omit=dev \
 && rm -rf node_modules/prisma \
           node_modules/@prisma/config \
           node_modules/@prisma/debug \
           node_modules/@prisma/engines \
           node_modules/@prisma/engines-version \
           node_modules/@prisma/fetch-engine \
           node_modules/@prisma/get-platform \
           node_modules/deepmerge-ts \
 && npx playwright install --with-deps chromium \
 && chmod -R 755 /ms-playwright \
 && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
RUN mkdir -p /app/storage/uploads/tmp && chown -R node:node /app/storage
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
