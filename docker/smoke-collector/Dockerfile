# The stack smoke's collector: the OpAMP supervisor 0.162.0 running
# otelcol-contrib 0.162.0, enrolled in a fleet by
# scripts/smoke-test-stack.sh, which builds this image under a throwaway tag
# and removes it when it ends:
#
#   docker build --build-arg VALIDATOR_IMAGE=<the stack's validator image> \
#     -t <tag> docker/smoke-collector
#
# Nothing is fetched for it beyond the supervisor's image (pinned by its
# index digest, resolved on 2026-10-12): the collector binary is copied out
# of the stack's own collector validator image (VALIDATOR_IMAGE, built from
# services/otelcol-validator), which must hold v0.162.0, the supervisor's
# own version: the catalogue's default today, which it always holds (CI's
# stack job and the throwaway gate stacks build it with
# OTELCOL_VERSIONS=default). Move both together, with the catalogue's
# default: scripts/smoke-test-stack.sh refuses to start while this COPY's
# version or the supervisor's FROM tag isn't the default.
#
# What a collector is told comes from its container's environment, read by
# supervisor.yaml as ${env:NAME} (the supervisor 0.162 expands them):
#
#   TELFLO_OPAMP_ENDPOINT      the agent endpoint, http://<host>:51234/opamp/api/v1
#   TELFLO_OPAMP_BEARER        an enrollment token's bearer (pass it by a bare
#                              `docker run -e TELFLO_OPAMP_BEARER`, never on a
#                              command line)
#   TELFLO_COLLECTOR_NAME      its ServerName: the name it asks for
#   TELFLO_COLLECTOR_GROUP_ID  the group it joins, required: the opamp-server
#                              refuses a collector naming no group. This
#                              image runs the supervisor itself, with no
#                              script of its own to refuse an empty one, so
#                              the smoke's start_collector and
#                              managed_start_collector refuse it instead
#
# Each container is one collector: its instance uid is made on its first
# start and kept in its own storage, so a new container is a new collector.
ARG VALIDATOR_IMAGE=telflo-otelcol-validator:dev

FROM ${VALIDATOR_IMAGE} AS validator

FROM otel/opentelemetry-collector-opampsupervisor:0.162.0@sha256:13af4526381fe8279fb78f211628fea5cae693bf413737f234ee3587d9a44fb6

COPY --from=validator --chmod=0755 /opt/otelcol/v0.162.0/otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --chmod=0644 supervisor.yaml local.yaml /etc/telflo-smoke/

CMD ["--config", "/etc/telflo-smoke/supervisor.yaml"]
