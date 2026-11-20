#!/bin/bash
# Tests for scripts/smoke-kind/image-id.sh (the kind smoke's step-4 image-id
# check) and its store switch through scripts/release/
# oci.sh's telflo_engine_store, offline: a stand-in `docker` first on PATH
# answers `info` (the classic or containerd image store), `image inspect`
# (the host's id) and `exec <node> crictl|ctr` (the node's record) from the
# case's settings. Run:  bash scripts/smoke-kind/image-id.test.sh
# (bash 3.2 compatible)
set -u
TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd)" || exit 1; export TMPDIR
root="$(cd "$(dirname "$0")/../.." && pwd)"

failures=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; failures=$((failures + 1)); fi; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/image-id-test.XXXXXX")" || exit 1
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'DOCKER'
#!/bin/bash
# SD_STORE classic|containerd; SD_HOST_ID; SD_NODE_CONFIG (crictl's .status.id);
# SD_NODE_TAGS (crictl's repoTags, space-separated); SD_NODE_TARGET (ctr's DIGEST for SD_NODE_NAME).
case "$1" in
  info)
    if [ "$SD_STORE" = containerd ]; then
      echo '[["driver-type","io.containerd.snapshotter.v1"]]'
    else
      echo '[["Backing Filesystem","extfs"],["Supports d_type","true"]]'
    fi ;;
  image) [ -n "${SD_HOST_ID:-}" ] && echo "$SD_HOST_ID" || exit 1 ;;
  exec)
    shift 2
    case "$1" in
      crictl)
        # SD_CRICTL_FAILS: the first N calls time out, as a busy node's containerd does.
        n=$(( $(cat "$SD_CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$SD_CALLS"
        if [ "$n" -le "${SD_CRICTL_FAILS:-0}" ]; then
          echo 'getting image status: rpc error: code = DeadlineExceeded desc = context deadline exceeded' >&2; exit 1
        fi
        case " $* " in *" --timeout 10s "*) ;; *) exit 98 ;; esac
        tags="$(for t in ${SD_NODE_TAGS:-}; do printf '"%s",' "$t"; done)"
        printf '{"status":{"id":"%s","repoTags":[%s]}}\n' "${SD_NODE_CONFIG:-}" "${tags%,}" ;;
      ctr)
        echo "REF TYPE DIGEST SIZE PLATFORMS LABELS"
        [ "$6" = "name==${SD_NODE_NAME:-}" ] && echo "$SD_NODE_NAME application/vnd.oci.image.manifest.v1+json ${SD_NODE_TARGET:-} 10.0MiB linux/amd64 -" ;;
      *) exit 97 ;;
    esac ;;
  *) exit 97 ;;
esac
DOCKER
chmod +x "$tmp/bin/docker"
PATH="$tmp/bin:$PATH"; export PATH
export SD_CALLS="$tmp/crictl-calls" SK_PAUSE=0

config=sha256:1111111111111111111111111111111111111111111111111111111111111111
manifest=sha256:2222222222222222222222222222222222222222222222222222222222222222
other=sha256:3333333333333333333333333333333333333333333333333333333333333333
api=ghcr.io/telflo/telflo/api:0.1.0

# shellcheck source=scripts/smoke-kind/image-id.sh
. "$root/scripts/smoke-kind/image-id.sh"
# shellcheck source=scripts/release/oci.sh
. "$root/scripts/release/oci.sh"
ids() { # <image> <store>: rc of smoke_kind_image_ids
  smoke_kind_image_ids "$1" node "$2"
}

check "the names as the node's containerd gives them" \
  "[ \"\$(smoke_kind_normalized nginx:1.27-alpine)\" = docker.io/library/nginx:1.27-alpine ] && [ \"\$(smoke_kind_normalized axllent/mailpit:v1.31)\" = docker.io/axllent/mailpit:v1.31 ] && [ \"\$(smoke_kind_normalized $api)\" = $api ] && [ \"\$(smoke_kind_normalized localhost/x:1)\" = localhost/x:1 ]"

export SD_STORE=classic
check "telflo_engine_store: classic" "[ \"\$(telflo_engine_store)\" = classic ]"
export SD_HOST_ID=$config SD_NODE_CONFIG=$config SD_NODE_TAGS=$api SD_NODE_NAME=$api SD_NODE_TARGET=$manifest
check "classic store: the host's config digest equals the node's: loaded" "ids $api classic"
export SD_CRICTL_FAILS=2; rm -f "$SD_CALLS"
check "classic store: crictl timing out twice, then answering: loaded, on the third try" \
  "ids $api classic && [ \"\$(cat '$SD_CALLS')\" = 3 ] && [ -z \"\$SK_NODE_ERR\" ]"
export SD_CRICTL_FAILS=99; rm -f "$SD_CALLS"
check "classic store: crictl never answering: refused after SK_TRIES (5) tries, its error kept" \
  "! ids $api classic && [ \"\$(cat '$SD_CALLS')\" = 5 ] && [ -z \"\$SK_NODE_ID\" ] && printf '%s' \"\$SK_NODE_ERR\" | grep -qF 'context deadline exceeded'"
export SD_CRICTL_FAILS=99 SK_TRIES=1; rm -f "$SD_CALLS"
check "SK_TRIES=1: one try only" "! ids $api classic && [ \"\$(cat '$SD_CALLS')\" = 1 ]"
unset SK_TRIES; export SD_CRICTL_FAILS=0
export SD_NODE_CONFIG=$other
check "classic store: another config digest in the node: refused, both ids named" \
  "! ids $api classic && [ \"\$SK_HOST_ID\" = $config ] && [ \"\$SK_NODE_ID\" = $other ]"

export SD_STORE=containerd
check "telflo_engine_store: containerd" "[ \"\$(telflo_engine_store)\" = containerd ]"
# On containerd's store the host's id is the manifest digest; the node's .status.id stays the config digest.
export SD_HOST_ID=$manifest SD_NODE_CONFIG=$config SD_NODE_TAGS=$api SD_NODE_NAME=$api SD_NODE_TARGET=$manifest
check "containerd store: the comparison the classic store makes would refuse a good load (the ruling's case)" "! ids $api classic"
check "containerd store: the host's manifest digest equals the node's record of that name: loaded" "ids $api containerd"
export SD_NODE_TARGET=$other
check "containerd store: the node's record targets another manifest: refused" "! ids $api containerd && [ \"\$SK_NODE_ID\" = $other ]"
export SD_NODE_TARGET=$manifest SD_NODE_TAGS=ghcr.io/telflo/telflo/web:0.1.0
check "containerd store: the node doesn't know the image by its name: refused" "! ids $api containerd && [ -z \"\$SK_NODE_ID\" ]"
export SD_NODE_TAGS=docker.io/library/nginx:1.27-alpine SD_NODE_NAME=docker.io/library/nginx:1.27-alpine SD_HOST_ID=$manifest
check "containerd store: a bare name (nginx:1.27-alpine) found under docker.io/library/: loaded" "ids nginx:1.27-alpine containerd"
export SD_HOST_ID=""
check "no host id (the image isn't local): refused, either store" "! ids nginx:1.27-alpine containerd && ! ids nginx:1.27-alpine classic"
check "smoke-kind.sh sources image-id.sh and oci.sh and compares through smoke_kind_image_ids with the engine's store" \
  "grep -q '^\\. \"\$REPO/scripts/smoke-kind/image-id.sh\"' '$root/scripts/smoke-kind.sh' && grep -q '^ENGINE_STORE=\$(telflo_engine_store)' '$root/scripts/smoke-kind.sh' && grep -q 'smoke_kind_image_ids \"\$image\" \"\$NODE\" \"\$ENGINE_STORE\"' '$root/scripts/smoke-kind.sh'"

echo
if [ "$failures" -eq 0 ]; then echo "ALL PASS"; else echo "$failures FAILURE(S)"; exit 1; fi
