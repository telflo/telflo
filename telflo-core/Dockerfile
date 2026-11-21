# Images for the TypeScript workspace, one build target per component:
#
#   api   the Fastify API, compiled; also runs migrations (compose's
#         migrate, the chart's migrate init container) and the
#         operator's commands (`telflo-admin`)
#   web   the React Router server-rendered web app
#
# Built by the root docker-compose.yml, with the repository's root as the
# build context, so every path below is from there: telflo-core/ for the
# workspace, catalog/ for the collector catalog, install-templates/ for the
# install templates. The root .dockerignore lets only those (and the Python
# services' directories) in. scripts/publish-platform-images.sh builds both
# targets for linux/amd64 and linux/arm64 from HEAD's committed files, as
# ghcr.io/telflo/telflo/api and .../web, passing VERSION and REVISION (the
# version and revision labels).
#
# Production-only: each final stage starts from a fresh base and holds only
# what its component runs: the API its compiled JavaScript (tsc's dist/ of
# @telflo/contracts, @telflo/db and apps/api), the migrations and its
# production dependencies; web its server build and its production
# dependencies. No development dependency (tsx, TypeScript, Vite, the test
# runners, ...) reaches either: `npm ci --omit=dev -w <workspace>` installs
# only that workspace's dependency tree (without -w, every workspace's), and
# never with --omit=optional (argon2's native binary is an optional
# dependency). scripts/check-no-dev-dependencies.mjs checks a built image
# against the lockfile. Development keeps running TypeScript from src/
# through tsx.
#
# Both run as uid and gid 1000, the base's `node` user, by number, so an
# orchestrator can check runAsNonRoot.

# node:24-bookworm-slim (Node 24.22.2), pinned by its index digest, the same
# as scripts/smoke-kind.sh's NODE_BASE. Moving it is a reviewed change: pull
# the new tag and take its index digest from
# `docker image inspect <tag> --format '{{.RepoDigests}}'`.
ARG NODE_BASE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# ---- manifests: the workspace's package files, the npm ci layers' input -----
FROM ${NODE_BASE} AS manifests
WORKDIR /app
# Manifests first, so editing source doesn't invalidate the npm ci layers.
COPY telflo-core/package.json telflo-core/package-lock.json ./
COPY telflo-core/apps/api/package.json apps/api/
COPY telflo-core/apps/cli/package.json apps/cli/
COPY telflo-core/apps/web/package.json apps/web/
COPY telflo-core/packages/contracts/package.json packages/contracts/
COPY telflo-core/packages/db/package.json packages/db/
COPY telflo-core/packages/tsconfig/package.json packages/tsconfig/

# ---- deps: every workspace's dependencies, for the build stages only ---------
FROM manifests AS deps
RUN npm ci
COPY telflo-core/ ./

# ---- api-build: tsc to dist/, the packages pointed at it -------------------
# Each package the API runs is compiled to its dist/, at the same depth as
# its src/, so the files read relative to import.meta.url (the migrations,
# the catalog, the reference page's assets) resolve as they do from src/;
# the tests and test support are left out (tsconfig.build.json).
# image/point-at-dist.mjs then copies the non-TypeScript files beside the
# code and points the three package.json files at dist/ (here only).
FROM deps AS api-build
RUN npx tsc -p packages/contracts/tsconfig.build.json \
 && npx tsc -p packages/db/tsconfig.build.json \
 && npx tsc -p apps/api/tsconfig.build.json \
 && node image/point-at-dist.mjs

# ---- api-deps: the API's production dependencies --------------------------
FROM manifests AS api-deps
RUN npm ci --omit=dev -w @telflo/api

# ---- api ---------------------------------------------------------------------
FROM ${NODE_BASE} AS api
WORKDIR /app
COPY --from=api-deps /app/node_modules /app/node_modules
COPY --from=api-build /app/package.json /app/package.json
COPY --from=api-build /app/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=api-build /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=api-build /app/packages/db/package.json /app/packages/db/package.json
COPY --from=api-build /app/packages/db/dist /app/packages/db/dist
COPY --from=api-build /app/packages/db/migrations /app/packages/db/migrations
COPY --from=api-build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=api-build /app/apps/api/dist /app/apps/api/dist
# The collector catalog, which the migrations (this image) sync into the
# database: packages/db finds it at /catalog, four levels above
# /app/packages/db/dist, as above src/. The API process never reads it.
COPY catalog/ /catalog/
# The file store's root, compose's file-store volume: created here and given
# to uid 1000 (node), the user the API runs as, so a new volume mounted on it
# starts with that owner. Only node may enter it.
RUN mkdir -p /var/lib/telflo/file-store \
 && chown 1000:1000 /var/lib/telflo/file-store \
 && chmod 0700 /var/lib/telflo/file-store
# `telflo-admin`: the operator's commands, run beside the API with its
# environment (`kubectl exec deploy/telflo-api -- telflo-admin bootstrap
# --email <email> --organization <name>`, or `docker compose exec api
# telflo-admin …`). A shim on PATH, owned by root.
RUN printf '#!/bin/sh\nexec node /app/apps/api/dist/admin/telflo-admin.js "$@"\n' >/usr/local/bin/telflo-admin \
 && chmod 0755 /usr/local/bin/telflo-admin
# The install templates' default set, read on every render from
# TELFLO_INSTALL_TEMPLATES_DIR (this path by default): an operator replaces it
# with a directory of their own (a Kubernetes ConfigMap or volume, a
# customer's air-gapped directory), and compose mounts the repository's
# install-templates/ over it read-only. Owned by root, readable by node.
COPY install-templates/ /etc/telflo/install-templates/
WORKDIR /app/apps/api
# The release's version and its commit (scripts/publish-platform-images.sh
# passes both); the defaults mark a local build. Declared after the last
# RUN, so a new version or commit never rebuilds a layer.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/telflo/telflo" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.title="Telflo platform API" \
      org.opencontainers.image.description="The Telflo platform's API (Fastify); also runs the database migrations"
USER 1000:1000
EXPOSE 8080
# The migrations: `node dist/migrate.js` in /app/packages/db.
CMD ["node", "dist/index.js"]

# ---- web-build: the server build ---------------------------------------------
FROM deps AS web-build
# The collector catalog's renames: the build bundles each file's
# renamedTypes, found at /catalog, six levels above
# /app/apps/web/app/lib/collector. The server never reads the files. Vite
# bundles whatever the glob finds, even nothing, so the build is refused here
# when no distribution file arrived; the web would otherwise build and then
# fail as it loads the renames.
COPY catalog/ /catalog/
RUN set -- /catalog/distributions/*.json && [ -e "$1" ] || { \
      echo "The web needs catalog/distributions/*.json, the collector catalogue: none at /catalog/distributions." >&2; \
      exit 1; \
    }
WORKDIR /app/apps/web
RUN npm run build

# ---- web-deps: the web's production dependencies -----------------------------
FROM manifests AS web-deps
RUN npm ci --omit=dev -w @telflo/web

# ---- web ---------------------------------------------------------------------
FROM ${NODE_BASE} AS web
WORKDIR /app
COPY --from=web-deps /app/node_modules /app/node_modules
COPY --from=web-build /app/package.json /app/package.json
COPY --from=web-build /app/apps/web/package.json /app/apps/web/package.json
COPY --from=web-build /app/apps/web/server.mjs /app/apps/web/server.mjs
COPY --from=web-build /app/apps/web/build /app/apps/web/build
COPY --from=web-build /app/apps/web/public /app/apps/web/public
WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=3000
# The release's version and its commit (scripts/publish-platform-images.sh
# passes both); the defaults mark a local build. Declared after the last
# RUN, so a new version or commit never rebuilds a layer.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/telflo/telflo" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.title="Telflo platform web" \
      org.opencontainers.image.description="The Telflo platform's web app (React Router, server-rendered)"
USER 1000:1000
EXPOSE 3000
# The web app's own server (apps/web/server.mjs): it resolves build/ and
# public/ against its own folder and logs no request. node runs it directly,
# never npx (which writes ~/.npm).
CMD ["node", "server.mjs"]
