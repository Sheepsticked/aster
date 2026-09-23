# Aster — controller image: Node 24 pinned by digest (node:sqlite needs ≥ 24.15), production dependencies of the controller
# workspace only, runs as root (no USER, see the end). The web UI is built in the first stage and only its
# output travels: `dist/` lands where env.js looks for it by default (packages/ui/dist beside the controller), so the image
# serves the SPA without a setting, and neither Vite nor a node_modules of the UI is in the image that runs.
# Build from the repository root; the context is cut down by the allowlist in /.dockerignore:
#   docker build -f docker/controller/Dockerfile -t aster/aster-controller:dev .
ARG NODE_IMAGE=node:24.21.0-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

FROM ${NODE_IMAGE} AS ui
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
# --ignore-scripts also keeps @playwright/test from downloading a browser: the responsive check runs outside the image.
RUN npm ci --workspace packages/ui --ignore-scripts --no-audit --no-fund
COPY packages/ui/index.html packages/ui/vite.config.js packages/ui/
COPY packages/ui/src packages/ui/src
RUN npm run build --workspace packages/ui

FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
LABEL org.opencontainers.image.title="aster-controller" \
      org.opencontainers.image.description="Aster controller: JSON API, SQLite store, AMI client, spool ingester, notifications, web UI" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"
ENV NODE_ENV=production \
    ASTER_HOME=/srv/aster
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/controller/package.json packages/controller/
RUN npm ci --omit=dev --workspace packages/controller --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY packages/controller/src packages/controller/src
COPY packages/controller/bin packages/controller/bin
COPY --from=ui /app/packages/ui/dist packages/ui/dist
# No USER: runs as root, since no fixed uid reliably owns the bind-mounted home; the compose file mounts only
# config/, state/, spool/, logs/ and backups/ of it.
CMD ["node", "packages/controller/src/index.js"]
