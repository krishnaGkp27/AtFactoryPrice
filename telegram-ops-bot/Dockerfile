# syntax=docker/dockerfile:1.6
#
# telegram-ops-bot Dockerfile — DEPLOY-C1
#
# Build strategy: copy package manifests FIRST (so Docker caches the
# expensive `npm ci` layer), then copy source. When only source changes
# (the 99% case), Railway reuses the node_modules layer and the build
# finishes in ~30s instead of ~4min.
#
# Image tested: node:20-alpine on Railway (small, fast cold-start).

FROM node:20-alpine AS deps

# pdftoppm + ghostscript: required by sharp/pdf-poppler-lite for OCR.
# git: occasionally needed for npm postinstall of git+ssh packages.
RUN apk add --no-cache poppler-utils ghostscript

WORKDIR /app

# ---- dependency layer (cached across deploys when manifests unchanged) ----
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime layer ----
FROM node:20-alpine
RUN apk add --no-cache poppler-utils ghostscript

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
# Railway injects PORT at runtime; default to 3000 for local docker runs.
ENV PORT=3000
EXPOSE 3000

# Run as non-root for defence-in-depth.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

# CRITICAL: use `node` directly (not `npm start`) so SIGTERM from Railway
# reaches our process. With `npm start` as PID 1, SIGTERM is swallowed
# and the container is hard-killed after 10s — losing in-flight callbacks.
CMD ["node", "server.js"]
