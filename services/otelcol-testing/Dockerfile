# The collector tester's image, built with the REPOSITORY'S ROOT as the
# context, so it can read catalog/ (the root .dockerignore lets in only
# telflo-core/, catalog/ and the two Python services):
#
#   docker build -f services/otelcol-testing/Dockerfile -t telflo-otelcol-testing .
#   docker build -f services/otelcol-testing/Dockerfile --build-arg OTELCOL_VERSIONS=default ...
#   docker build -f services/otelcol-testing/Dockerfile --target test -t telflo-otelcol-testing-test .
#   docker run --rm --network none telflo-otelcol-testing-test pytest -m "binary or kwok" -q
#
# OTELCOL_VERSIONS picks the collectors it bakes in, as the validator's
# image does: `all` (the default, every offered version in catalog/),
# `default` (the catalogue's default version), or a comma-separated list of
# offered versions. A name the catalogue doesn't offer, or a download whose
# sha256 isn't the catalogue's, fails the build. A version the catalogue
# offers but the image doesn't hold answers 503 `version_unavailable`.
#
# Stages: download (the collectors, kwok's five binaries and tini, each
# checked against its pinned sha256, with Python's standard library: no curl
# or jq), runtime (the service), test (the runtime plus the development lock
# and the tests). The default target is the runtime.
#
# The image mirrors the repository's layout under /app (the service in
# /app/services/otelcol-testing, the catalogue in /app/catalog/distributions),
# so the service's default catalogue directory (app/settings.py, three
# directories above its package) is the copy the image carries.
#
# It is meant to run as compose runs it (docker-compose.yml): a read-only root
# filesystem with tmpfs at /tmp (each run's workspace) and at the user's home
# (kwok's cluster state; etcd's WAL alone is 128 MB), an internal network with
# no route out, and the shared secret in a file (OTELCOL_TESTING_SECRET_FILE),
# never in the environment. Docker's tmpfs is noexec, so every binary lives
# under /opt, owned by root and read-only to the service.

# python:3.12-slim (Debian trixie), pinned by its index digest: the
# validator's (a reviewed component). To move it, take the new
# index digest from `docker buildx imagetools inspect python:3.12-slim`, in
# both services' Dockerfiles.
ARG PYTHON_IMAGE=python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

# ---- download: the collectors, kwok and tini, each against its sha256 --------
FROM ${PYTHON_IMAGE} AS download
# BuildKit's target architecture (amd64 or arm64): the collectors are
# linux_${TARGETARCH}, and so are kwok's binaries and tini.
ARG TARGETARCH
# tini (MIT, krallin/tini): PID 1, so the processes kwokctl starts in the
# background (etcd, kube-apiserver, kwok) and whatever a killed run leaves
# are reaped, and signals reach the service. The validator's build,
# dynamically linked against the base image's glibc; each hash is the
# release's own .sha256sum file.
ARG TINI_VERSION=v0.19.0
ARG TINI_SHA256_AMD64=93dcc18adc78c65a028a84799ecf8ad40c936fdfc5f2a57b1acda5a8117fa82c
ARG TINI_SHA256_ARM64=07952557df20bfd2a95f9bef198b445e006171969499a1d361bd9e6f8e5e0e81
WORKDIR /build
# The validator's downloader, unchanged (fetch and check by sha256, the
# catalogue's collectors); kwok's manifest and its own small script use it.
COPY services/otelcol-validator/scripts/download-binaries.py ./
RUN case "$TARGETARCH" in \
      amd64) sha256="$TINI_SHA256_AMD64" ;; \
      arm64) sha256="$TINI_SHA256_ARM64" ;; \
      *) echo "no tini for linux/$TARGETARCH" >&2; exit 1 ;; \
    esac \
 && python download-binaries.py file \
      --url "https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-${TARGETARCH}" \
      --sha256 "$sha256" --dest /out/tini --mode 755
# kwok's five (kwok, kwokctl, kubectl, kube-apiserver, etcd): the manifest
# pins each by sha256 per architecture. etcd's archive is checked whole and
# only its etcd file is copied out.
COPY services/otelcol-testing/scripts/download-kwok.py ./
COPY services/otelcol-testing/kwok/binaries.json ./kwok-binaries.json
RUN python download-kwok.py --manifest kwok-binaries.json --arch "$TARGETARCH" --dest /out/kwok
# The catalogue and the build argument come last, so changing either
# downloads only the collectors again.
COPY catalog/distributions/ ./catalog/distributions/
ARG OTELCOL_VERSIONS=all
RUN python download-binaries.py collectors \
      --catalog ./catalog/distributions --versions "$OTELCOL_VERSIONS" \
      --arch "$TARGETARCH" --dest /out/otelcol

# ---- runtime -----------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

LABEL org.opencontainers.image.title="telflo otelcol-testing"
LABEL org.opencontainers.image.description="Runs a test of an OpenTelemetry Collector configuration with otelcol-contrib of its pinned version, in a sandbox"
LABEL org.opencontainers.image.vendor="Telflo"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

# The service's user (uid 10001, numeric so an orchestrator can check
# runAsNonRoot), with its home directory: compose mounts a tmpfs there (kwok
# keeps its cluster under ~/.kwok). The base image has the openssl command,
# whose package ca-certificates depends on; the runtime needs none of it
# (kwokctl makes its certificates itself), so only the command goes.
RUN rm /usr/bin/openssl \
 && groupadd --system --gid 10001 otelcol-testing \
 && useradd --system --uid 10001 --gid 10001 --create-home \
      --home-dir /home/otelcol-testing --shell /usr/sbin/nologin otelcol-testing
COPY --from=download --chown=0:0 /out/tini /usr/local/bin/tini

# kwok's binaries, then the collectors, before the Python dependencies: the
# largest layer changes only with the catalogue or OTELCOL_VERSIONS. Owned
# by root (`--chown=0:0` explicitly: BuildKit's cache key for a COPY ignores
# its files' owners, so a cached layer of another build, with an archive's
# owner on etcd, could otherwise stand in), read-only to the service. Each
# must run here and say its own version.
# Under emulation (a cross-platform build: the other processor type's stage)
# Go binaries crash at random (QEMU, both ways), so the "run and say its
# version" checks below run in a native build only (BUILDPLATFORM =
# TARGETPLATFORM; a plain docker build sets neither: native).
# The release builds amd64 natively on the runner and the rehearsal arm64
# natively on an Apple machine; every binary's sha256 is checked at download.
ARG BUILDPLATFORM
ARG TARGETPLATFORM
COPY --from=download --chown=0:0 /out/kwok/ /opt/kwok/
RUN set -e; kwok=/opt/kwok/v0.7.0; \
    if [ "${BUILDPLATFORM:-}" != "${TARGETPLATFORM:-}" ]; then \
      echo "cross build (${BUILDPLATFORM} -> ${TARGETPLATFORM}): kwok's --version checks run in a native build only"; exit 0; \
    fi; \
    "$kwok/kwok" --version | grep -qF "v0.7.0"; \
    "$kwok/kwokctl" --version | grep -qF "v0.7.0"; \
    "$kwok/kubectl" version --client | grep -qF "v1.31.6"; \
    "$kwok/kube-apiserver" --version | grep -qF "v1.31.6"; \
    "$kwok/etcd" --version | grep -qF "3.5.21"
COPY --from=download --chown=0:0 /out/otelcol/ /opt/otelcol/
RUN if [ "${BUILDPLATFORM:-}" != "${TARGETPLATFORM:-}" ]; then \
      echo "cross build (${BUILDPLATFORM} -> ${TARGETPLATFORM}): the collectors' --version check runs in a native build only"; \
    else for binary in /opt/otelcol/v*/otelcol-contrib; do \
      version="${binary#/opt/otelcol/v}"; version="${version%/otelcol-contrib}"; \
      "$binary" --version | grep -qF " $version" \
        || { echo "$binary doesn't say it is $version" >&2; exit 1; }; \
    done; fi

WORKDIR /app/services/otelcol-testing
# The hash-pinned runtime lock only: wheels, no dependency outside the lock.
# PyYAML's wheels carry libyaml, which the neutraliser's bounded reader needs
# (CSafeLoader): checked here.
COPY services/otelcol-testing/requirements.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt \
 && python -c "import yaml; yaml.CSafeLoader"

COPY catalog/distributions/ /app/catalog/distributions/
COPY services/otelcol-testing/telemetry.py ./
COPY services/otelcol-testing/app/ ./app/
# kwokctl's configuration (passed as `kwokctl -c`) and the seeded pod.
COPY services/otelcol-testing/kwok/kwokctl.yaml ./kwok/
COPY services/otelcol-testing/fixtures/kwok/ ./fixtures/kwok/
# Compiled as root: the service's user can't write here (nor can anyone: the
# root filesystem is read-only in compose), and each run's child process
# (`python -E -s -m app.run_child`) imports the package afresh.
RUN python -m compileall -q app telemetry.py

ENV OTELCOL_BINARY_DIR=/opt/otelcol \
    OTELCOL_CATALOG_DIR=/app/catalog/distributions \
    KWOK_BINARY_DIR=/opt/kwok

# The release's version and its commit (scripts/publish-platform-images.sh
# passes both); the defaults mark a local build. Declared after the runtime's
# last RUN, so a new version or commit never rebuilds a layer.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/telflo/telflo" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

# OTELCOL_TESTING_SECRET_FILE (a file of at least 32 bytes, readable by uid
# 10001) is required: without it the service refuses to start, and it
# refuses a secret in its environment. The rest (README.md, Settings) have
# defaults.
USER 10001:10001
EXPOSE 8002
# 200 once kwok's cluster is up (a few seconds after start), 503 while it
# starts or after it failed; the service exits once kwok has failed every
# attempt, and compose's restart policy starts it afresh.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(urllib.request.urlopen('http://127.0.0.1:8002/testing/v1/health', timeout=4).status != 200)"]
# tini is PID 1: it reaps what a killed run or kwok leaves and passes
# signals on to the service.
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]

# ---- test: the runtime, plus the development lock and the tests -------------
# For `docker run --rm --network none <image> pytest -m "binary or kwok" -q`
# (CI's otelcol-testing job): the binary and kwok tests run the image's own
# collectors and kwok against every version it holds. OTELCOL_EXPECTED_VERSIONS
# tells them which versions this build baked in (its OTELCOL_VERSIONS), so a
# version it should hold and doesn't fails them instead of being skipped.
FROM runtime AS test
ARG OTELCOL_VERSIONS=all
ENV OTELCOL_EXPECTED_VERSIONS=${OTELCOL_VERSIONS}
USER root
# ps, which the process tests read the process table with
# (tests/test_run_process.py and others): only here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
COPY services/otelcol-testing/requirements-dev.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: -r requirements-dev.txt
COPY services/otelcol-testing/pytest.ini services/otelcol-testing/openapi.yaml ./
COPY services/otelcol-testing/kwok/ ./kwok/
COPY services/otelcol-testing/scripts/ ./scripts/
COPY services/otelcol-testing/tests/ ./tests/
# The build context's catalog/, apart from the image's own copy, so the image
# test can check the copy the service reads is catalog/'s, file for file and
# byte for byte.
COPY catalog/distributions/ /opt/context-catalog/distributions/
ENV OTELCOL_CONTEXT_CATALOG_DIR=/opt/context-catalog/distributions
# pytest's temporary directories (each test's tmp_path, where the fake
# collectors are written and run) go to a directory the service's user owns
# and may execute from: not /tmp, which compose (and a `--read-only
# --tmpfs /tmp` run) mounts noexec. pytest can't write its cache here, and
# warnings fail the run (pytest.ini). The neutraliser's identity test
# compares the copies with the validator's files, which this image doesn't
# carry: it runs in the repository's suite only.
RUN install -d -o 10001 -g 10001 -m 0700 /var/tmp/otelcol-testing-tests
ENV PYTEST_ADDOPTS="-p no:cacheprovider --basetemp=/var/tmp/otelcol-testing-tests/pytest --ignore=tests/test_neutraliser_identity.py"
USER 10001:10001
CMD ["pytest", "-m", "binary or kwok", "-q"]

# ---- the default target: the runtime image ------------------------------------
FROM runtime
