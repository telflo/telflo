# shellcheck shell=bash
# image-id.sh: the kind smoke's step-4 check that an image loaded into the
# node is the host's (D36-2 Ruling 394). Sourced by scripts/smoke-kind.sh
# (and its test), never run.
#
#   smoke_kind_image_ids <image> <node container> <store>
#       sets SK_HOST_ID and SK_NODE_ID and returns 0 when they are equal and
#       not empty. <store> is scripts/release/oci.sh's telflo_engine_store:
#         classic     the host's image id (`docker image inspect .Id`) is the
#                     image's config digest, and so is the node's (`crictl
#                     inspecti`'s .status.id);
#         containerd  the host's id is the image's manifest digest (its
#                     target: load-images.sh pulls one platform's image by
#                     its manifest digest: the engine's own, or the one
#                     --platform names), so the node's is the target digest of
#                     its image record of that name (`ctr -n k8s.io images
#                     ls name==<name>`, the name as crictl normalizes it:
#                     docker.io/library/ for a bare name).
#       The node is asked by `crictl --timeout 10s inspecti`, up to
#       SK_TRIES times (default 5) SK_PAUSE seconds apart (default 2), until
#       it answers: right after a large `kind load` the node's containerd
#       can be slow to, and crictl's own 2 s default then reads as no image.
#       SK_NODE_ERR holds crictl's last error output (empty when it answered).
#   smoke_kind_normalized <image>
#       prints the image's name as the node's containerd names it.
# bash 3.2 compatible; it sets no shell option.

smoke_kind_normalized() {
  local name="$1" first
  case "$name" in
    */*)
      first="${name%%/*}"
      case "$first" in
        *.* | *:* | localhost) printf '%s\n' "$name" ;;
        *) printf 'docker.io/%s\n' "$name" ;;
      esac ;;
    *) printf 'docker.io/library/%s\n' "$name" ;;
  esac
}

# smoke_kind_inspect <image> <node>: SK_NODE_JSON crictl's JSON for the
# image, retried until crictl answers; SK_NODE_ERR its last error. (Variables,
# not standard output: a command substitution's subshell would lose them.)
smoke_kind_inspect() {
  local image="$1" node="$2" try=1 tries="${SK_TRIES:-5}" out err
  SK_NODE_JSON=""
  err="$(mktemp "${TMPDIR:-/tmp}/image-id.XXXXXX")" || return 1
  while :; do
    if out="$(docker exec "$node" crictl --timeout 10s inspecti -o json "$image" 2>"$err")" && [ -n "$out" ]; then
      SK_NODE_JSON="$out"; SK_NODE_ERR=""; rm -f "$err"; return 0
    fi
    SK_NODE_ERR="$(tr '\n' ' ' <"$err" | cut -c1-300)"
    [ "$try" -lt "$tries" ] || { rm -f "$err"; return 1; }
    try=$((try + 1)); sleep "${SK_PAUSE:-2}"
  done
}

smoke_kind_image_ids() {
  local image="$1" node="$2" store="$3" name
  SK_HOST_ID="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)"
  SK_NODE_ID=""
  SK_NODE_ERR=""
  smoke_kind_inspect "$image" "$node" || true
  if [ "$store" = containerd ]; then
    name="$(smoke_kind_normalized "$image")"
    # The node must know the image by that name (crictl's repoTags), and its record's target digest is compared.
    if printf '%s\n' "$SK_NODE_JSON" | jq -e --arg n "$name" '(.status.repoTags // []) | index($n) != null' >/dev/null 2>&1; then
      SK_NODE_ID="$(docker exec "$node" ctr -n k8s.io images ls "name==$name" 2>/dev/null | awk 'NR == 2 { print $3 }' || true)"
    fi
  else
    SK_NODE_ID="$(printf '%s\n' "$SK_NODE_JSON" | jq -r '.status.id // empty' 2>/dev/null || true)"
  fi
  [ -n "$SK_HOST_ID" ] && [ "$SK_HOST_ID" = "$SK_NODE_ID" ]
}
