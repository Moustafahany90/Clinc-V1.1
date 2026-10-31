# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build the static SPA. VITE_API_URL stays empty for same-origin /api/v1,
# which Nginx proxies to the backend service.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ---------------------------------------------------------------------------
# Serve the SPA. No clinic data is stored or served from this container:
# uploaded files live in the backend storage volume and are streamed only
# through authorised API endpoints.
# ---------------------------------------------------------------------------
FROM nginx:1.30-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
