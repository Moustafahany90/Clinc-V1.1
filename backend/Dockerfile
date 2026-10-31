# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

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
 && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
RUN mkdir -p /app/storage/uploads/tmp && chown -R node:node /app/storage
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
