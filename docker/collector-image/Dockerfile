# telflo's collector image: otelcol-contrib and the OpAMP supervisor, one tag
# per collector version (ghcr.io/telflo/telflo/collector:<version>).
#
# The base image is pinned by its index digest, and the build arguments
# are fed from the collector catalogue.
#
# Generic by design: no fleet secrets, endpoints or EXPOSE statements are
# baked in. A collector's identity arrives in environment variables at run
# time (see entrypoint.sh), and its ports with the configuration the OpAMP
# server sends (publish them with `docker run -p`).
#
# Built by scripts/build-collector-image.sh <version>, which reads the
# version's linux_amd64 and linux_arm64 otelcol-contrib and opampsupervisor
# download URLs and sha256 from catalog/distributions/otelcol-contrib.json and
# passes them as the build arguments below. Pushing the image is left to the
# maintainers.
#
# debian:bookworm-slim, the index digest it resolved to on 2026-10-16 (the
# image created 2026-10-05; linux/amd64 and linux/arm64 among its platforms).
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# buildx sets TARGETARCH (amd64|arm64); select that architecture's pinned
# binaries. Only the archive's otelcol-contrib is unpacked, owned by root.
ARG TARGETARCH
ARG OTELCOL_URL_AMD64
ARG OTELCOL_SHA256_AMD64
ARG OTELCOL_URL_ARM64
ARG OTELCOL_SHA256_ARM64
ARG SUPERVISOR_URL_AMD64
ARG SUPERVISOR_SHA256_AMD64
ARG SUPERVISOR_URL_ARM64
ARG SUPERVISOR_SHA256_ARM64

RUN set -eu; \
    case "${TARGETARCH:-}" in \
      amd64) otel_url="${OTELCOL_URL_AMD64:-}"; otel_sha="${OTELCOL_SHA256_AMD64:-}"; \
             sup_url="${SUPERVISOR_URL_AMD64:-}"; sup_sha="${SUPERVISOR_SHA256_AMD64:-}" ;; \
      arm64) otel_url="${OTELCOL_URL_ARM64:-}"; otel_sha="${OTELCOL_SHA256_ARM64:-}"; \
             sup_url="${SUPERVISOR_URL_ARM64:-}"; sup_sha="${SUPERVISOR_SHA256_ARM64:-}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH:-}" >&2; exit 1 ;; \
    esac; \
    [ -n "$otel_url" ] || { echo "missing OTELCOL_URL_* build arg for $TARGETARCH" >&2; exit 1; }; \
    [ -n "$otel_sha" ] || { echo "missing OTELCOL_SHA256_* build arg for $TARGETARCH" >&2; exit 1; }; \
    [ -n "$sup_url" ] || { echo "missing SUPERVISOR_URL_* build arg for $TARGETARCH" >&2; exit 1; }; \
    [ -n "$sup_sha" ] || { echo "missing SUPERVISOR_SHA256_* build arg for $TARGETARCH" >&2; exit 1; }; \
    otel_file="${otel_url##*/}"; \
    curl -fL --proto '=https' --retry 3 --retry-connrefused -o "$otel_file" "$otel_url"; \
    echo "$otel_sha  $otel_file" | sha256sum -c -; \
    tar --no-same-owner -xf "$otel_file" otelcol-contrib; \
    rm -f "$otel_file"; \
    curl -fL --proto '=https' --retry 3 --retry-connrefused -o supervisor "$sup_url"; \
    echo "$sup_sha  supervisor" | sha256sum -c -; \
    chmod +x supervisor

COPY otelcol-config.yaml .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
