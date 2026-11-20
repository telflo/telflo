#!/usr/bin/env bash
# Checks the running collector tester's container from the inside: uid
# 10001, a read-only root filesystem with tmpfs for runs and kwok, no route
# out (external names don't resolve, external addresses don't answer), and
# the secret in no environment, the service's process not dumpable, and no
# capability or privilege gained through exec. scripts/container-probe.py
# does the checking, piped into the container's own Python (nothing is
# copied in, and the image carries no probe).
#
# Then the forwarder (otelcol-testing-forward): its nginx runs as uid 101,
# master and workers, with no capability and no-new-privileges, on a
# read-only root, and has workers (as root without capabilities its master
# couldn't start any and served nothing).
#
#   services/otelcol-testing/scripts/check-container.sh [compose options...]
#
# Run it once the stack is up (CI's `stack` job does). Its arguments go to
# `docker compose` before `exec`, so it can check a throwaway project:
#
#   check-container.sh -p my-throwaway -f /path/to/compose-copy.yml
#
# It exits 1 when any check fails, printing which.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0
docker compose "$@" exec -T otelcol-testing python - < "$here/container-probe.py" || status=1

echo "the forwarder:"
docker compose "$@" exec -T otelcol-testing-forward sh -s <<'PROBE' || status=1
failed=0
check() { if [ "$2" = 0 ]; then echo "ok $1"; else echo "FAIL $1: $3"; failed=1; fi; }
masters=0
workers=0
for status_file in /proc/[0-9]*/status; do
    pid="${status_file#/proc/}"; pid="${pid%/status}"
    command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$command" in
        "nginx: master"*) masters=$((masters + 1)) ;;
        "nginx: worker"*) workers=$((workers + 1)) ;;
        *) continue ;;
    esac
    uid="$(awk '/^Uid:/ {print $2 "/" $3}' "$status_file")"
    [ "$uid" = "101/101" ]; check "nginx process $pid runs as uid 101" $? "uid $uid"
    held="$(awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ && $2 != "0000000000000000" {printf "%s %s ", $1, $2}' "$status_file")"
    [ -z "$held" ]; check "nginx process $pid holds no capability" $? "$held"
    nnp="$(awk '/^NoNewPrivs:/ {print $2}' "$status_file")"
    [ "$nnp" = 1 ]; check "nginx process $pid has no-new-privileges" $? "NoNewPrivs $nnp"
done
[ "$masters" = 1 ]; check "the forwarder's nginx master is running" $? "$masters found"
[ "$workers" -ge 1 ]; check "the forwarder's nginx has workers" $? "$workers found"
options="$(awk '$2 == "/" {print $4}' /proc/self/mounts)"
case ",$options," in *,ro,*) ro=0 ;; *) ro=1 ;; esac
check "the forwarder's root filesystem is mounted read-only" $ro "$options"
if [ "$failed" = 0 ]; then echo "every forwarder check passed"; else echo "a forwarder check failed"; fi
exit $failed
PROBE
exit $status
