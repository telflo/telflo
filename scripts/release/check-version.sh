#!/usr/bin/env bash
# check-version.sh: one release version, everywhere it is written (D36-2
# decision 75; Q279). Each place must hold a release version
# (MAJOR.MINOR.PATCH: digits only, no leading zeros, nothing before or
# after; scripts/release/version.sh holds the pattern), and every place the
# same one.
#
#   scripts/release/check-version.sh       (no argument; from anywhere)
#
# The places, in order:
#   - charts/telflo/Chart.yaml's version and appVersion;
#   - deploy/compose/compose.yaml: each Telflo image's tag
#     (ghcr.io/telflo/telflo/<name>:<version>, one place per image line;
#     none at all is a problem);
#   - README.md's Quick start (between its markers,
#     scripts/release/quick-start.sh): each release download address
#     (releases/download/v<version>) and each archive name
#     (telflo-compose-<version>, less a final .tar.gz), one place each;
#     none at all, or markers that aren't there once each in order, is a
#     problem;
#   - README.md anywhere: each `gh release download v<version>` (the
#     download while the repository is private), one place each; none at
#     all is fine;
#   - docs/kubernetes.md: each `--version <version>` on a line naming the
#     chart oci://ghcr.io/telflo/telflo/charts/telflo, and each release
#     download address (releases/download/v<version>), one place each;
#     none at all is a problem.
#
# Offline and quick: it only reads the tree's files. Each problem is a line
# naming the place (and, for a difference, both places and both values).
# Exit 0 every place agrees, 1 a problem, 2 usage. bash 3.2 compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/release/version.sh
. "$SCRIPT_DIR/version.sh"
# shellcheck source=scripts/release/quick-start.sh
. "$SCRIPT_DIR/quick-start.sh"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/release/check-version.sh (no argument)" >&2
  exit 2
fi

problems=0
places=0
names=""
version=""
first=""
problem() { echo "check-version: $*" >&2; problems=$((problems + 1)); }

# place <where> <value>: one place the version is written.
place() {
  local where="$1" value="$2"
  places=$((places + 1))
  names="${names:+$names, }$where"
  telflo_version_ok "$value" ||
    problem "$where is '$value', not a release version (MAJOR.MINOR.PATCH: digits only, no leading zeros, nothing before or after)"
  if [ -z "$first" ]; then
    first="$where"; version="$value"
  elif [ "$value" != "$version" ]; then
    problem "$where ($value) differs from $first ($version)"
  fi
}
# missing <where> <why>: a place that couldn't be read.
missing() { places=$((places + 1)); names="${names:+$names, }$1"; problem "$1: $2"; }

# ---- charts/telflo/Chart.yaml: version and appVersion.
CHART_YAML=charts/telflo/Chart.yaml
for key in version appVersion; do
  if value="$(telflo_chart_field "$REPO_DIR/$CHART_YAML" "$key")"; then
    place "$CHART_YAML's $key" "$value"
  else
    missing "$CHART_YAML's $key" "missing, or not exactly one top-level '$key:' line"
  fi
done

# ---- deploy/compose/compose.yaml: each Telflo image line's tag.
COMPOSE_YAML=deploy/compose/compose.yaml
# compose_images: "<line>|<name>|<tag>" for each image line naming
# ghcr.io/telflo/telflo/ (comments skipped; quotes and a digest dropped).
compose_images() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]+image:[[:space:]]/ {
      value = $0
      sub(/^[[:space:]]+image:[[:space:]]+/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/["\047]/, "", value)
      prefix = "ghcr.io/telflo/telflo/"
      if (index(value, prefix) != 1) next
      rest = substr(value, length(prefix) + 1)
      sub(/@.*$/, "", rest)
      colon = index(rest, ":")
      if (colon == 0) { print NR "|" rest "|"; next }
      print NR "|" substr(rest, 1, colon - 1) "|" substr(rest, colon + 1)
    }' "$REPO_DIR/$COMPOSE_YAML"
}
if [ -f "$REPO_DIR/$COMPOSE_YAML" ]; then
  images="$(compose_images)"
  if [ -z "$images" ]; then
    missing "$COMPOSE_YAML's Telflo images" "no image line names ghcr.io/telflo/telflo/<name>:<version>"
  else
    while IFS='|' read -r line_number image tag; do
      place "$COMPOSE_YAML:$line_number's $image image" "$tag"
    done <<<"$images"
  fi
else
  missing "$COMPOSE_YAML" "missing"
fi

# versions_in <file> <first line> <last line> <chart-line text or "">:
# "<line>|<kind>|<value>" for each version written on the lines from <first>
# to <last>: every releases/download/v<x> (kind "download address"), every
# telflo-compose-<x> less a final .tar.gz ("archive name"), and, on a line
# holding <chart-line text>, every --version <x> ("chart version"). <x> is
# its letters, digits and . + _ - only, less the dots that end a sentence,
# so a placeholder (<version>) is an empty value, which isn't a release
# version.
versions_in() {
  awk -v first="$2" -v last="$3" -v chart="$4" '
    function each(text, re, skip, kind,   value) {
      while (match(text, re)) {
        value = substr(text, RSTART + skip, RLENGTH - skip)
        sub(/^[[:space:]]+/, "", value)
        sub(/\.+$/, "", value)
        if (kind == "archive name") sub(/\.tar\.gz$/, "", value)
        print NR "|" kind "|" value
        text = substr(text, RSTART + RLENGTH)
      }
    }
    NR < first || NR > last { next }
    {
      each($0, "releases/download/v[0-9A-Za-z.+_-]*", 19, "download address")
      if (chart == "") each($0, "telflo-compose-[0-9A-Za-z.+_-]*", 15, "archive name")
      if (chart != "" && index($0, chart) > 0) each($0, "--version[[:space:]]+[0-9A-Za-z.+_-]*", 9, "chart version")
    }' "$1"
}

# ---- README.md's Quick start: its download lines.
README=README.md
if [ -f "$REPO_DIR/$README" ]; then
  if telflo_quick_start_region "$REPO_DIR/$README" >/dev/null; then
    begin_line="$(grep -n -x '[[:space:]]*<!-- quick-start:begin -->[[:space:]]*' "$REPO_DIR/$README" | cut -d: -f1)"
    end_line="$(grep -n -x '[[:space:]]*<!-- quick-start:end -->[[:space:]]*' "$REPO_DIR/$README" | cut -d: -f1)"
    found="$(versions_in "$REPO_DIR/$README" "$begin_line" "$end_line" "")"
    if [ -z "$found" ]; then
      missing "$README's Quick start" "no download address or archive name (releases/download/v<version>, telflo-compose-<version>)"
    else
      while IFS='|' read -r line_number kind value; do
        place "$README:$line_number's $kind" "$value"
      done <<<"$found"
    fi
  else
    missing "$README's Quick start" "its markers aren't there once each, in order ($QUICK_START_BEGIN, then $QUICK_START_END)"
  fi
  # Anywhere in it: the private period's `gh release download v<version>`.
  found="$(awk '{
      text = $0
      while (match(text, /gh release download v[0-9A-Za-z.+_-]*/)) {
        value = substr(text, RSTART + 21, RLENGTH - 21)
        sub(/\.+$/, "", value)
        print NR "|" value
        text = substr(text, RSTART + RLENGTH)
      }
    }' "$REPO_DIR/$README")"
  if [ -n "$found" ]; then
    while IFS='|' read -r line_number value; do
      place "$README:$line_number's gh release download" "$value"
    done <<<"$found"
  fi
else
  missing "$README" "missing"
fi

# ---- docs/kubernetes.md: the chart's --version and the release downloads.
KUBERNETES_MD=docs/kubernetes.md
if [ -f "$REPO_DIR/$KUBERNETES_MD" ]; then
  found="$(versions_in "$REPO_DIR/$KUBERNETES_MD" 1 999999 "oci://ghcr.io/telflo/telflo/charts/telflo")"
  if [ -z "$found" ]; then
    missing "$KUBERNETES_MD" "no chart version (oci://ghcr.io/telflo/telflo/charts/telflo --version <version>) or download address"
  else
    while IFS='|' read -r line_number kind value; do
      place "$KUBERNETES_MD:$line_number's $kind" "$value"
    done <<<"$found"
  fi
else
  missing "$KUBERNETES_MD" "missing"
fi

if [ "$problems" -ne 0 ]; then
  echo "check-version: FAIL ($problems problem(s) in $places place(s))" >&2
  exit 1
fi
echo "check-version: $version in all $places places ($names)"
