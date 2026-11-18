#!/usr/bin/env bash
# tools.sh: the release pipeline's private tools (D36-2 decision 110; Q281,
# Ruling 383). kind, crane, gitleaks and a newer buildx as pinned release binaries,
# each checked against the sha256 in tools.lock, in the git-ignored .tools/
# at the repository's root; the images the local runs need, by digest only.
# Nothing system-wide, no Homebrew, never ~/.docker or Docker Desktop's
# settings: buildx is reached through a temporary DOCKER_CONFIG.
#
#   tools.sh fetch [<tool>]        download each tool (or one) pinned for this OS and
#                                  processor type into .tools/<tool>/<version>/, check its
#                                  sha256 before it is made executable, and the binary's own
#                                  (taken from an archive) before it is installed (a mismatch
#                                  deletes the download and exits 1); a checked file is never
#                                  overwritten
#   tools.sh path <tool>           print the checked binary's path, or exit 1 (never downloads):
#                                  the binary is hashed again and must be tools.lock's binary
#                                  sha256 for this platform
#   tools.sh docker-config <dir>   make <dir> (new or empty) a DOCKER_CONFIG with no login
#                                  and the checked buildx in cli-plugins/
#   tools.sh pull <image-key>      pull an image tools.lock lists, by its digest only
#   tools.sh ref <image-key>       print its pinned reference (<repository>@<digest>)
#   tools.sh remove                remove the builder tools.lock names, every image it
#                                  marks `remove` (by digest) and .tools/
#
# It writes nothing outside .tools/ and the folder `docker-config` is given.
# Every docker call runs with DOCKER_CONFIG .tools/docker-config (no login)
# and refusing docker-credential-* stand-ins first on PATH; a call to one
# fails the command. Exit 0 done, 1 failed, 2 usage or refused.
# TELFLO_TOOLS_DIR (a folder named .tools), TELFLO_TOOLS_LOCK and
# TELFLO_TOOLS_PLATFORM (<os>-<arch>) are for its self-test and a local
# fetch for another platform; in a workflow (CI set to anything but "",
# false or 0: oci.sh's telflo_in_ci) any of them set is refused (exit 2):
# there the tools are the repository's tools.lock's, for the runner's own
# platform, in the repository's .tools/ (Ruling 399).
# bash 3.2 compatible.
set -uo pipefail

case "${CI:-}" in
  "" | false | 0) ;;
  *)
    ci_set=""
    [ -z "${TELFLO_TOOLS_DIR+set}" ] || ci_set="$ci_set TELFLO_TOOLS_DIR"
    [ -z "${TELFLO_TOOLS_LOCK+set}" ] || ci_set="$ci_set TELFLO_TOOLS_LOCK"
    [ -z "${TELFLO_TOOLS_PLATFORM+set}" ] || ci_set="$ci_set TELFLO_TOOLS_PLATFORM"
    if [ -n "$ci_set" ]; then
      echo "tools.sh: refused:$ci_set set, and CI is: in a workflow the tools are tools.lock's, for this platform, in the repository's .tools/" >&2
      exit 2
    fi ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLS_DIR="${TELFLO_TOOLS_DIR:-$REPO_DIR/.tools}"
LOCK="${TELFLO_TOOLS_LOCK:-$SCRIPT_DIR/tools.lock}"

usage() {
  sed -n 's/^#   tools\.sh /tools.sh /p' "$0" >&2
  exit 2
}
refuse() { echo "tools.sh: refused: $*" >&2; exit 2; }
fail() { echo "tools.sh: FAIL: $*" >&2; exit 1; }
say() { echo "tools.sh: $*"; }

[ "$(basename "$TOOLS_DIR")" = .tools ] || refuse "the tools folder must be named .tools"
[ -f "$LOCK" ] || fail "no lock file"

platform() {
  if [ -n "${TELFLO_TOOLS_PLATFORM:-}" ]; then echo "$TELFLO_TOOLS_PLATFORM"; return; fi
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) os=unknown ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) arch=unknown ;; esac
  echo "$os-$arch"
}

sha256_of() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

# lock_tool <name> <platform>: sets T_VERSION T_URL T_SHA T_SUMS T_MEMBER T_BIN
# (the binary's sha256: the download's when it is the binary), or returns 1.
lock_tool() {
  local name=$1 plat=$2 line
  line=$(awk -v n="$1" -v p="$2" '$1 == "tool" && $2 == n && $4 == p { print; exit }' "$LOCK")
  [ -n "$line" ] || return 1
  set -f; set -- $line; set +f
  [ "$#" = 9 ] || fail "tools.lock's line for $name ($plat) hasn't 9 fields"
  T_VERSION=$3 T_URL=$5 T_SHA=$6 T_SUMS=$7 T_MEMBER=$8 T_BIN=$9
  printf '%s' "$T_VERSION" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+$' || fail "tools.lock: $name's version isn't x.y.z"
  printf '%s' "$T_SHA" | grep -Eq '^[0-9a-f]{64}$' || fail "tools.lock: $name's sha256 isn't 64 hex"
  case "$T_URL" in https://*|file:///*) ;; *) fail "tools.lock: $name's URL isn't https" ;; esac
  printf '%s' "$T_MEMBER" | grep -Eq '^(-|[A-Za-z0-9][A-Za-z0-9._-]*)$' || fail "tools.lock: $name's member isn't a plain name"
  if [ "$T_MEMBER" = - ]; then
    [ "$T_BIN" = - ] || fail "tools.lock: $name's download is the binary: its binary sha256 field is -"
    T_BIN=$T_SHA
  else
    printf '%s' "$T_BIN" | grep -Eq '^[0-9a-f]{64}$' || fail "tools.lock: $name's binary sha256 isn't 64 hex"
  fi
}
lock_tools() { awk '$1 == "tool" { print $2 }' "$LOCK" | awk '!seen[$0]++'; }

# lock_image <key>: sets I_REPO I_TAG I_DIGEST I_AFTER, or returns 1.
lock_image() {
  local key=$1 line
  line=$(awk -v k="$1" '$1 == "image" && $2 == k { print; exit }' "$LOCK")
  [ -n "$line" ] || return 1
  set -f; set -- $line; set +f
  [ "$#" = 6 ] || refuse "tools.lock's image $key hasn't 6 fields (a digest among them)"
  I_REPO=$3 I_TAG=$4 I_DIGEST=$5 I_AFTER=$6
  printf '%s' "$I_REPO" | grep -Eq '^[a-z0-9][a-z0-9._/-]*$' || fail "tools.lock: image $key's repository isn't a plain name"
  printf '%s' "$I_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || refuse "tools.lock: image $key has no sha256 digest"
  case "$I_AFTER" in remove|keep) ;; *) fail "tools.lock: image $key's last field is remove or keep" ;; esac
}

key_ok() { # <key>: a lock key, never a reference
  printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]*$' ||
    refuse "'$1' isn't an image key of tools.lock (a key, never a reference: tools.sh ref <key> prints one)"
}

# The checked binary of <tool> at the lock's version, or return 1: hashed
# again, it must be tools.lock's binary sha256 for this platform (and fetch's
# .checked record of it).
checked_binary() { # <tool>: sets B_PATH
  lock_tool "$1" "$(platform)" || return 1
  local dir="$TOOLS_DIR/$1/$T_VERSION" sum
  B_PATH="$dir/$1"
  [ -f "$B_PATH" ] && [ ! -L "$B_PATH" ] && [ -x "$B_PATH" ] && [ -f "$dir/.checked" ] || return 1
  sum=$(sha256_of "$B_PATH")
  [ "$sum" = "$(cat "$dir/.checked")" ] || return 1
  [ "$sum" = "$T_BIN" ] || return 1
}

fetch_one() { # <tool>
  local tool=$1 plat dir stage sum
  plat=$(platform)
  lock_tool "$tool" "$plat" || fail "tools.lock pins no $tool for $plat"
  dir="$TOOLS_DIR/$tool/$T_VERSION"
  if checked_binary "$tool"; then
    say "$tool $T_VERSION ($plat): already fetched and checked: $B_PATH"
    return 0
  fi
  [ ! -e "$dir" ] || fail "$dir exists but doesn't check against tools.lock: never overwritten; run tools.sh remove, then fetch"
  mkdir -p "$TOOLS_DIR/$tool" || fail "cannot make $TOOLS_DIR/$tool"
  stage=$(mktemp -d "$TOOLS_DIR/$tool/.fetch.XXXXXX") || fail "cannot make a download folder"
  say "$tool $T_VERSION ($plat): downloading"
  if ! curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 2 -o "$stage/download" "$T_URL"; then
    rm -rf "$stage"
    fail "$tool: the download failed"
  fi
  sum=$(sha256_of "$stage/download")
  if [ "$sum" != "$T_SHA" ]; then
    rm -rf "$stage"
    fail "$tool $T_VERSION ($plat): the download's sha256 isn't tools.lock's ($T_SUMS): deleted"
  fi
  say "$tool: sha256 matches tools.lock ($T_SUMS)"
  if [ "$T_MEMBER" = - ]; then
    mv "$stage/download" "$stage/$tool" || { rm -rf "$stage"; fail "$tool: cannot move the download"; }
  else
    mkdir "$stage/x" && tar -xzf "$stage/download" -C "$stage/x" "$T_MEMBER" 2>/dev/null ||
      { rm -rf "$stage"; fail "$tool: $T_MEMBER isn't in the checked archive"; }
    [ -f "$stage/x/$T_MEMBER" ] && [ ! -L "$stage/x/$T_MEMBER" ] ||
      { rm -rf "$stage"; fail "$tool: $T_MEMBER in the archive isn't a plain file"; }
    mv "$stage/x/$T_MEMBER" "$stage/$tool" || { rm -rf "$stage"; fail "$tool: cannot move $T_MEMBER"; }
  fi
  if [ "$(sha256_of "$stage/$tool")" != "$T_BIN" ]; then
    rm -rf "$stage"
    fail "$tool $T_VERSION ($plat): the binary's sha256 isn't tools.lock's: deleted"
  fi
  chmod 755 "$stage/$tool" || { rm -rf "$stage"; fail "$tool: chmod failed"; }
  sha256_of "$stage/$tool" >"$stage/.checked"
  mkdir "$dir" || { rm -rf "$stage"; fail "$tool: cannot make $dir"; }
  mv "$stage/$tool" "$stage/.checked" "$dir/" || { rm -rf "$stage"; fail "$tool: cannot move into $dir"; }
  rm -rf "$stage"
  checked_binary "$tool" || fail "$tool: the fetched binary doesn't check"
  say "$tool $T_VERSION ($plat): $B_PATH"
}

# Docker with no login and the refusing stand-ins (brief-rules' D18 rules).
docker_guard() {
  mkdir -p "$TOOLS_DIR/docker-config" "$TOOLS_DIR/standins" || fail "cannot make $TOOLS_DIR's docker folders"
  printf '{"auths":{"telflo-agent.invalid":{}}}\n' >"$TOOLS_DIR/docker-config/config.json"
  export DOCKER_CONFIG="$TOOLS_DIR/docker-config"
  : >>"$TOOLS_DIR/standins.log"
  local helper
  for helper in osxkeychain desktop ecr-login; do
    printf '#!/bin/sh\nprintf "%%s\\n" "$1" >>"%s/standins.log"\nexit 1\n' "$TOOLS_DIR" >"$TOOLS_DIR/standins/docker-credential-$helper"
    chmod 755 "$TOOLS_DIR/standins/docker-credential-$helper"
  done
  export PATH="$TOOLS_DIR/standins:$PATH"
}
helpers_check() { # <log>
  [ ! -s "$1" ] || fail "a docker credential helper was called ($(wc -l <"$1" | tr -d ' ') calls)"
}

action=${1:-}
[ -n "$action" ] && shift || usage
case "$action" in
  fetch)
    [ "$#" -le 1 ] || usage
    if [ "$#" = 1 ]; then
      fetch_one "$1"
    else
      for tool in $(lock_tools); do fetch_one "$tool"; done
    fi
    ;;
  path)
    [ "$#" = 1 ] || usage
    checked_binary "$1" || { echo "tools.sh: $1 isn't fetched and checked for $(platform) (tools.sh fetch $1)" >&2; exit 1; }
    echo "$B_PATH"
    ;;
  docker-config)
    [ "$#" = 1 ] || usage
    dir=$1
    case "$dir" in /*) ;; *) refuse "docker-config takes an absolute path" ;; esac
    case "$dir" in "$HOME/.docker"|"$HOME/.docker/"*) refuse "never ~/.docker" ;; esac
    [ ! -e "$dir" ] || [ -z "$(ls -A "$dir" 2>/dev/null)" ] || refuse "$dir isn't empty"
    checked_binary buildx || fail "buildx isn't fetched and checked for $(platform) (tools.sh fetch buildx)"
    (umask 077 && mkdir -p "$dir/cli-plugins") || fail "cannot make $dir"
    printf '{"auths":{"telflo-agent.invalid":{}}}\n' >"$dir/config.json"
    cp "$B_PATH" "$dir/cli-plugins/docker-buildx" && chmod 755 "$dir/cli-plugins/docker-buildx" || fail "cannot copy buildx"
    [ "$(sha256_of "$dir/cli-plugins/docker-buildx")" = "$(sha256_of "$B_PATH")" ] || fail "the copied buildx doesn't check"
    echo "$dir"
    ;;
  ref)
    [ "$#" = 1 ] || usage
    key_ok "$1"
    lock_image "$1" || refuse "tools.lock lists no image $1"
    echo "$I_REPO@$I_DIGEST"
    ;;
  pull)
    [ "$#" = 1 ] || usage
    key_ok "$1"
    lock_image "$1" || refuse "tools.lock lists no image $1"
    ref="$I_REPO@$I_DIGEST"
    docker_guard
    if docker image inspect "$ref" >/dev/null 2>&1; then
      say "$1: $I_REPO $I_TAG is local by its digest"
    else
      say "$1: pulling $I_REPO $I_TAG by its digest"
      docker pull "$ref" || fail "$1: docker pull failed"
    fi
    id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null) || fail "$1: not local after the pull"
    helpers_check "$TOOLS_DIR/standins.log"
    say "$1: $ref (image id $id)"
    ;;
  remove)
    [ "$#" = 0 ] || usage
    status=0
    if command -v docker >/dev/null 2>&1; then
      docker_guard
      for builder in $(awk '$1 == "builder" { print $2 }' "$LOCK"); do
        printf '%s' "$builder" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || fail "tools.lock: the builder's name isn't plain"
        if docker container inspect "buildx_buildkit_${builder}0" >/dev/null 2>&1; then
          docker rm -f "buildx_buildkit_${builder}0" >/dev/null && say "removed the builder $builder's container" || status=1
        fi
        if docker volume inspect "buildx_buildkit_${builder}0_state" >/dev/null 2>&1; then
          docker volume rm "buildx_buildkit_${builder}0_state" >/dev/null && say "removed the builder $builder's state volume" || status=1
        fi
      done
      for key in $(awk '$1 == "image" { print $2 }' "$LOCK"); do
        # An entry tools.sh can't have pulled (no digest) is named, not removed.
        if ! (lock_image "$key") >/dev/null 2>&1; then
          echo "tools.sh: $key: tools.lock's entry isn't a pinned image: nothing removed" >&2
          status=1
          continue
        fi
        lock_image "$key"
        ref="$I_REPO@$I_DIGEST"
        if [ "$I_AFTER" = keep ]; then
          say "$key: kept (tools.lock: keep)"
        elif docker image inspect "$ref" >/dev/null 2>&1; then
          docker rmi "$ref" >/dev/null && say "$key: removed $ref" || { echo "tools.sh: $key: docker rmi $ref failed (in use?)" >&2; status=1; }
        else
          say "$key: not local"
        fi
      done
      helpers_check "$TOOLS_DIR/standins.log"
    else
      say "no docker CLI: no image or builder removed"
    fi
    if [ -e "$TOOLS_DIR" ]; then
      rm -rf "$TOOLS_DIR" && say "removed $TOOLS_DIR" || status=1
    fi
    exit "$status"
    ;;
  *) usage ;;
esac
exit 0
