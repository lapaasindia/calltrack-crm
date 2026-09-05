# syntax=docker/dockerfile:1
# CallTrack CRM — production container image (Coolify, docker compose, plain
# docker). See README "Deploy on a server (Docker / Coolify)".
#
#   stage 1  builds the React client (needs the root package.json: the version
#            is baked into the bundle as __APP_VERSION__)
#   stage 2  the lean runtime: Node 22, ffmpeg (recording transcoding — the
#            optional whisper.cpp AI binary is NOT included), curl (Coolify's
#            health probe runs it inside the container), tini (PID 1 that
#            forwards SIGTERM so `docker stop` runs the graceful shutdown),
#            production npm deps only, server + built client. All state lives
#            in /data (mount a volume); the process runs as the unprivileged
#            `node` user.
#
# better-sqlite3 13 ships its N-API prebuilds (linux-x64 / linux-arm64, glibc)
# inside the npm tarball, so `npm ci` needs no compiler; `--ignore-scripts`
# mirrors CI — the only install scripts in the production tree (baileys'
# engine check, protobufjs' version warning) are advisory.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Stage 1: web client ──────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS client-build
WORKDIR /build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci
COPY client/ ./client/
RUN npm --prefix client run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && node -e "require('better-sqlite3')"

COPY server/ ./server/
COPY scripts/ ./scripts/
COPY --from=client-build /build/client/dist ./client/dist

# /data: database, backups, recordings, logs, session store, secret.key, APK.
# Owned by `node` so a named volume initialised from it is writable. A host
# directory bind-mounted here must be chown'ed to uid/gid 1000 first.
RUN mkdir -p /data/backups && chown -R node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production \
    CRM_DATA_DIR=/data \
    CRM_BACKUP_DIR=/data/backups \
    PORT=3000 \
    CRM_TRUST_PROXY=1 \
    CRM_LOG_STDOUT=1

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
