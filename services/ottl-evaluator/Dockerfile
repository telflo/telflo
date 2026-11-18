# The OTTL evaluator's image (D15a spec decision 10; plan Preflight ruling
# 13), built from this directory, as the root docker-compose.yml does:
#
#   docker build -t telflo-ottl-evaluator services/ottl-evaluator
#
# Built as the opamp-server's is. One binary, six subcommands
# (cmd/server/main.go; D25 added lint-child):
#
#   serve            the default: the API on OTTL_EVALUATOR_PORT (8003)
#   healthcheck      asks this container's own /health, for the container
#                    health check (no shell or curl here)
#   evaluate-child   one evaluation's, validation's or lint's work, which
#   validate-child   serve runs in a child process of this binary, killed
#   lint-child       at its limit
#   selfcheck        checks this container from the inside: its user,
#                    capabilities, read-only root, network and secret
#                    (scripts/check-container.sh runs it)

# ---- build stage ----------------------------------------------------------
# The Go 1.26 line go.mod names (go 1.26.9; pkg/ottl has needed Go 1.26
# since v0.160.0), pinned by its index digest: golang:1.26-alpine was Go
# 1.26.9 on Alpine 3.24 when resolved, on 2026-10-11. To move it, take the
# new digest from `docker buildx imagetools inspect golang:1.26-alpine`.
# Alpine keeps the build image small; CGO is disabled in the build step so
# the binary is fully static and runs on distroless/static without libc.
# --platform=$BUILDPLATFORM: this stage is the builder's platform's, whatever
# the target, and cross-compiles (GOOS and GOARCH below), as the
# opamp-server's does: an emulated amd64 build crashes at `go mod download`
# under QEMU (D33-1 decision 12, Preflight ruling 12). Only the runtime stage
# is per platform.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS builder

# go.mod's toolchain is the one this image carries: never let a go command
# download another (docs/conventions/go.md).
ENV GOTOOLCHAIN=local

WORKDIR /src

# Cache module downloads across layer rebuilds when only source files change.
# RUN --mount is BuildKit's (Docker's default builder), in its built-in
# Dockerfile frontend, so this file names no `# syntax=` image to fetch.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# The target's OS and architecture (BuildKit sets them per platform),
# declared after the download so its layer is the same for every platform.
ARG TARGETOS TARGETARCH

# Copy the rest of the source. .dockerignore keeps local binaries, .env
# files, docs, the scripts and the tests out of the build context.
COPY . .

# -trimpath strips local paths from the binary; -ldflags '-s -w' drops the
# symbol table and DWARF info to shrink it. The module's own version
# information (the pkg/ottl version /health reports) stays in.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/ottl-evaluator ./cmd/server

# ---- runtime stage --------------------------------------------------------
# distroless/static: no shell, no package manager, ~2MB base. The :nonroot
# tag's user is uid 65532. The opamp-server's index digest, a reviewed
# component (ADR 0019, amended by D13b and D15a); resolved on 2026-10-07. To
# move it, take the new digest from `docker buildx imagetools inspect
# gcr.io/distroless/static-debian12:nonroot`, and move both images together.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

LABEL org.opencontainers.image.title="telflo ottl-evaluator"
LABEL org.opencontainers.image.description="Telflo's OTTL evaluator: checks a test run's validation rules (text, regex and OTTL) against the collector's output and log"
LABEL org.opencontainers.image.vendor="Telflo"
# The release's version and its commit (scripts/publish-platform-images.sh
# passes both); the defaults mark a local build.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/telflo/telflo" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

WORKDIR /app

COPY --from=builder /out/ottl-evaluator /app/ottl-evaluator

# The API's port (OTTL_EVALUATOR_PORT's default). The variables serve reads,
# all supplied by the orchestrator (README.md, "Configuration"):
#
#   OTTL_EVALUATOR_SECRET_FILE (required: the secret's file, at least 32
#   bytes; compose mounts /run/secrets/ottl_evaluator_secret, readable by
#   uid 65532), OTTL_EVALUATOR_SECRETS_PREVIOUS_FILE (during a rotation),
#   OTTL_EVALUATOR_PORT, OTTL_EVALUATOR_HOST, and the caps
#   OTTL_EVALUATOR_MAX_EVALUATIONS, _MAX_VALIDATIONS,
#   _MAX_EVALUATE_BODY_BYTES, _MAX_VALIDATE_BODY_BYTES and
#   _MAX_OUTPUT_OBJECTS (each may be lowered, never raised).
#
# healthcheck reads OTTL_EVALUATOR_PORT and OTTL_EVALUATOR_HOST. The
# children get none of serve's environment: only GOMEMLIMIT=640MiB and
# GOMAXPROCS=2 (serve's own GOMAXPROCS, set by compose, isn't passed on).
# Nothing writes to the filesystem, so compose runs it with a read-only root
# and no tmpfs.
EXPOSE 8003

# The base's nonroot user, by number, so an orchestrator can check
# runAsNonRoot (D33-1 decision 12).
USER 65532:65532

ENTRYPOINT ["/app/ottl-evaluator"]
CMD ["serve"]
