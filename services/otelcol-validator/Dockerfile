# The collector validator's image, built with the REPOSITORY'S ROOT as the
# context, so it can read catalog/ (the root .dockerignore lets in only
# telflo-core/, catalog/ and this service):
#
#   docker build -f services/otelcol-validator/Dockerfile -t telflo-otelcol-validator .
#   docker build -f services/otelcol-validator/Dockerfile --build-arg OTELCOL_VERSIONS=default ...
#   docker build -f services/otelcol-validator/Dockerfile --target test -t telflo-otelcol-validator-test .
#   docker run --rm --network none telflo-otelcol-validator-test pytest -m binary -q
#
# OTELCOL_VERSIONS picks the collectors it bakes in: `all` (the default,
# every offered version in catalog/), `default` (the catalogue's default
# version), or a comma-separated list of offered versions. A name the
# catalogue doesn't offer, or a download whose sha256 isn't the catalogue's,
# fails the build. A version the catalogue offers but the image doesn't hold
# answers 503 `version_unavailable`.
#
# Stages: download (the collectors and tini, each checked, with Python's
# standard library: no curl or jq), staging (the fake cluster state, its CA
# made with openssl), runtime (the service), test (the runtime plus the
# development lock and the tests). The default target is the runtime.
#
# The image mirrors the repository's layout under /app (the service in
# /app/services/otelcol-validator, the catalogue in /app/catalog/distributions),
# so the service's default catalogue directory (app/settings.py, three
# directories above its package) is the copy the image carries.

# python:3.12-slim (Debian trixie), pinned by its index digest (a reviewed
# component). Resolved on 2026-10-07 (3.12.15); to move it, take
# the new index digest from `docker buildx imagetools inspect python:3.12-slim`.
ARG PYTHON_IMAGE=python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

# ---- download: the collectors and tini, each against its pinned sha256 -----
FROM ${PYTHON_IMAGE} AS download
# BuildKit's target architecture (amd64 or arm64): the collectors are
# linux_${TARGETARCH}.
ARG TARGETARCH
# tini (MIT, krallin/tini): PID 1, so a collector whose check was killed is
# reaped. The dynamically linked build, against the base image's glibc; each
# hash is the release's own .sha256sum file, checked against a fresh download
# on 2026-10-07.
ARG TINI_VERSION=v0.19.0
ARG TINI_SHA256_AMD64=93dcc18adc78c65a028a84799ecf8ad40c936fdfc5f2a57b1acda5a8117fa82c
ARG TINI_SHA256_ARM64=07952557df20bfd2a95f9bef198b445e006171969499a1d361bd9e6f8e5e0e81
WORKDIR /build
COPY services/otelcol-validator/scripts/download-binaries.py ./
RUN case "$TARGETARCH" in \
      amd64) sha256="$TINI_SHA256_AMD64" ;; \
      arm64) sha256="$TINI_SHA256_ARM64" ;; \
      *) echo "no tini for linux/$TARGETARCH" >&2; exit 1 ;; \
    esac \
 && python download-binaries.py file \
      --url "https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-${TARGETARCH}" \
      --sha256 "$sha256" --dest /out/tini --mode 755
# The catalogue and the build argument come after tini, so changing either
# downloads only the collectors again.
COPY catalog/distributions/ ./catalog/distributions/
ARG OTELCOL_VERSIONS=all
RUN python download-binaries.py collectors \
      --catalog ./catalog/distributions --versions "$OTELCOL_VERSIONS" \
      --arch "$TARGETARCH" --dest /out/otelcol

# ---- staging: the fake cluster state the collector's constructors read -----
# A service-account token, a namespace and a CA certificate
# (made here with openssl, its key thrown away, so neither openssl nor the
# key reaches the runtime). In-cluster Kubernetes clients built by
# `validate` (k8sattributes, the k8snode detector, ...) read them, then fail
# TLS against the placeholder CA, as intended.
FROM ${PYTHON_IMAGE} AS staging
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /staging/serviceaccount \
 && echo "otelcol-validator-placeholder-token" > /staging/serviceaccount/token \
 && echo "otelcol-validator" > /staging/serviceaccount/namespace \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
      -subj "/CN=otelcol-validator-placeholder" \
      -keyout /dev/null -out /staging/serviceaccount/ca.crt \
 && chmod 0644 /staging/serviceaccount/*

# ---- runtime -----------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="telflo otelcol-validator"
LABEL org.opencontainers.image.description="Checks an OpenTelemetry Collector configuration with otelcol-contrib validate of its pinned version"
LABEL org.opencontainers.image.vendor="Telflo"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

# The service's user (uid 10001, numeric so an orchestrator can check
# runAsNonRoot), with a home directory; and the directories the contrib
# packages create, plus the host and Kubernetes mount points components
# stat at validate time, owned by the user.
# The base image has no curl or jq; it has the openssl command, whose
# package ca-certificates depends on, so only the command is removed: the
# runtime needs none of the three.
RUN rm /usr/bin/openssl \
 && groupadd --system --gid 10001 otelcol-validator \
 && useradd --system --uid 10001 --gid 10001 --create-home \
      --home-dir /home/otelcol-validator --shell /usr/sbin/nologin otelcol-validator \
 && mkdir -p \
      /hostfs \
      /var/lib/otelcol/file_storage \
      /var/lib/otelcol-contrib/file_storage \
      /var/log/otelcol /var/log/journal \
      /etc/otelcol/certs \
 && chown -R 10001:10001 \
      /hostfs /var/lib/otelcol /var/lib/otelcol-contrib /var/log/otelcol /etc/otelcol
# /var/run is /run on Debian; the path is the one Kubernetes clients read.
COPY --from=staging /staging/serviceaccount/ /var/run/secrets/kubernetes.io/serviceaccount/
COPY --from=download /out/tini /usr/local/bin/tini

# The collectors before the Python dependencies: the largest layer changes
# only with the catalogue or OTELCOL_VERSIONS. Owned by root, read-only to
# the service. Each must run here and say its own version.
# Under emulation (a cross-platform build: the other processor type's stage)
# Go binaries crash at random (QEMU, both ways), so the "run and say its
# version" checks below run in a native build only (BUILDPLATFORM =
# TARGETPLATFORM; a plain docker build sets neither: native).
# The release builds amd64 natively on the runner and the rehearsal arm64
# natively on an Apple machine; every binary's sha256 is checked at download.
ARG BUILDPLATFORM
ARG TARGETPLATFORM
COPY --from=download /out/otelcol/ /opt/otelcol/
RUN if [ "${BUILDPLATFORM:-}" != "${TARGETPLATFORM:-}" ]; then \
      echo "cross build (${BUILDPLATFORM} -> ${TARGETPLATFORM}): the collectors' --version check runs in a native build only"; \
    else for binary in /opt/otelcol/v*/otelcol-contrib; do \
      version="${binary#/opt/otelcol/v}"; version="${version%/otelcol-contrib}"; \
      "$binary" --version | grep -qF " $version" \
        || { echo "$binary doesn't say it is $version" >&2; exit 1; }; \
    done; fi

WORKDIR /app/services/otelcol-validator
# The hash-pinned runtime lock only: wheels, no dependency outside the lock.
# PyYAML's wheels carry libyaml, which the service's loader needs
# (CSafeLoader): checked here.
COPY services/otelcol-validator/requirements.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt \
 && python -c "import yaml; yaml.CSafeLoader"

COPY catalog/distributions/ /app/catalog/distributions/
COPY services/otelcol-validator/telemetry.py ./
COPY services/otelcol-validator/app/ ./app/
# Compiled as root: the service's user can't write here, and each check's
# child process (`python -E -s -m app.check`) imports the package afresh.
RUN python -m compileall -q app telemetry.py

# Placeholder values for components that read them at
# validate time. The collector never sees the service's environment (an
# allowlist, app/runner.py); its own copies of these come from
# VALIDATION_ENV_OVERRIDES (app/placeholders.py), with the same values. Not
# OTEL_RESOURCE_ATTRIBUTES: the service's own telemetry reads it.
ENV K8S_NODE_NAME=otelcol-validator \
    K8S_POD_NAME=otelcol-validator \
    K8S_NAMESPACE=otelcol-validator \
    K8S_CLUSTER_NAME=otelcol-validator \
    KUBERNETES_SERVICE_HOST=kubernetes.default.svc \
    KUBERNETES_SERVICE_PORT=443

ENV OTELCOL_BINARY_DIR=/opt/otelcol \
    OTELCOL_CATALOG_DIR=/app/catalog/distributions

# The release's version and its commit (scripts/publish-platform-images.sh
# passes both); the defaults mark a local build. Declared after the runtime's
# last RUN, so a new version or commit never rebuilds a layer.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/telflo/telflo" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

# OTELCOL_VALIDATOR_SECRET (at least 32 bytes) is required: without it the
# service refuses to start. The rest (README.md, Settings) have defaults.
USER 10001:10001
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=4).status != 200)"]
# tini is PID 1: it reaps the collectors a killed check leaves (their
# parent, the check's child, is killed with them) and passes signals on.
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]

# ---- test: the runtime, plus the development lock and the tests -------------
# For `docker run --rm --network none <image> pytest -m binary -q` (CI's
# otelcol-validator job): the binary tests run the image's own collectors
# against every version it holds. OTELCOL_EXPECTED_VERSIONS tells them which
# versions this build baked in (its OTELCOL_VERSIONS), so a version it should
# hold and doesn't fails them instead of being skipped.
FROM runtime AS test
ARG OTELCOL_VERSIONS=all
ENV OTELCOL_EXPECTED_VERSIONS=${OTELCOL_VERSIONS}
USER root
# ps, which the process tests read the process table with (tests/guard.py,
# tests/test_check_process.py): only here, so the whole suite runs on Linux
# in the image too (`docker run ... pytest -q`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
COPY services/otelcol-validator/requirements-dev.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements-dev.txt
COPY services/otelcol-validator/pytest.ini services/otelcol-validator/openapi.yaml ./
COPY services/otelcol-validator/scripts/ ./scripts/
COPY services/otelcol-validator/tests/ ./tests/
# The opamp-server's org-token corpus (vendor/opamp-server), which
# tests/test_org_variables.py reads three folders above its own, as in the
# repository: here only, never in the runtime.
COPY vendor/opamp-server/org-token-corpus.json /app/vendor/opamp-server/org-token-corpus.json
# pytest can't write its cache here as the service's user, and warnings fail
# the run (pytest.ini).
ENV PYTEST_ADDOPTS="-p no:cacheprovider"
USER 10001:10001
CMD ["pytest", "-m", "binary", "-q"]

# ---- the default target: the runtime image ------------------------------------
FROM runtime
