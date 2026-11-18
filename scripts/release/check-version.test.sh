#!/usr/bin/env bash
# check-version.sh's self-test (D36-2 decision 75; Q279): the real tree
# passes; in a throwaway copy (the two scripts beside this test, and a
# charts/telflo/Chart.yaml written per case) the release versions pass and
# everything else fails:
#   pass: 0.1.0, 0.1.12, 1.0.0 (and a quoted or unquoted appVersion);
#   fail: 0.1.0-rc.1, 0.1.0+1, v0.1.0, 01.0.0, 0.1 (and other leading
#         zeros, a fourth part, a blank inside the quotes), an empty value,
#         a missing appVersion, a second version line, no Chart.yaml, and
#         version and
#         appVersion different (the failure names both places and both
#         values);
#   the Compose install (deploy/compose/compose.yaml, written per case
#   beside the chart): each Telflo image line's tag is a place (quoted or
#   not; comments and other images ignored); one image at another version,
#   an image without a tag, no Telflo image line, and no compose.yaml fail,
#   naming the place;
#   the README's Quick start (README.md, written per case): its download
#   address and archive name between the markers are places (one outside
#   them ignored); either at another version, a placeholder for the
#   version, markers missing or twice, no download line, and no README.md
#   fail, naming the place; a `gh release download v<version>` anywhere in
#   it (outside the markers) is a place too: at the version it passes,
#   at another version or a placeholder it fails, naming its line;
#   docs/kubernetes.md (written per case): the chart's --version and the
#   release download are places (another chart's --version ignored); either
#   at another version, neither there, and no kubernetes.md fail, naming the
#   place.
#
# Run: scripts/release/check-version.test.sh
# Offline; prints PASS/FAIL lines only; exit 1 when any case failed. The
# copies live in a temporary directory removed on exit; the repository's
# own files are only read. bash 3.2 compatible.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-version-test.XXXXXX")" || exit 2
if [ -z "$tmp" ] || [ ! -d "$tmp" ]; then echo "self-test: no temporary directory" >&2; exit 2; fi
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0
n=0
run_case() { # <name> <command...>
  local name="$1"; shift
  if "$@"; then
    echo "PASS - $name"; passed=$((passed + 1))
  else
    echo "FAIL - $name"; failed=$((failed + 1))
  fi
}

# fresh: a new copy in $c with the three scripts, an empty chart folder, an
# empty deploy/compose folder and an empty docs folder.
fresh() {
  n=$((n + 1)); c="$tmp/case$n"
  mkdir -p "$c/scripts/release" "$c/charts/telflo" "$c/deploy/compose" "$c/docs" &&
    cp "$SCRIPT_DIR/check-version.sh" "$SCRIPT_DIR/version.sh" "$SCRIPT_DIR/quick-start.sh" "$c/scripts/release/"
}
# readme <address version> <archive version>: the copy's README.md, its
# Quick start shaped like the real one (the download address on line 5,
# the archive's name on line 7), and an archive name outside the markers,
# which must be ignored.
readme() {
  {
    printf '# Telflo\n<!-- quick-start:begin -->\n```sh\n'
    printf '# Save the download address.\nrelease=https://github.com/telflo/telflo/releases/download/v%s\n' "$1"
    printf '# Unpack it.\ntar -xzf telflo-compose-%s.tar.gz\n```\n' "$2"
    printf '<!-- quick-start:end -->\nAn older one was telflo-compose-9.9.9.tar.gz.\n'
  } >"$c/README.md"
}
# kube <chart version> <download version>: the copy's docs/kubernetes.md:
# the chart's install on line 1, another chart's (ignored) on line 2, the
# release download on line 3.
kube() {
  {
    printf 'helm install telflo oci://ghcr.io/telflo/telflo/charts/telflo --version %s -n telflo\n' "$1"
    printf 'helm install opamp oci://ghcr.io/telflo/charts/opamp-server --version 0.2.4\n'
    printf 'curl -fsSL -O https://github.com/telflo/telflo/releases/download/v%s/create-secrets.sh\n' "$2"
  } >"$c/docs/kubernetes.md"
}
# docs_at <version>: both documents at <version> everywhere.
docs_at() { readme "$1" "$1" && kube "$1" "$1"; }
# compose <api tag> <web tag>: the copy's deploy/compose/compose.yaml, shaped
# like the real one: two Telflo image lines (the second quoted), another
# image by digest, a commented-out Telflo image that must be ignored.
compose() {
  {
    printf 'name: telflo\nservices:\n'
    printf '  # image: ghcr.io/telflo/telflo/api:9.9.9 (a comment)\n'
    printf '  db:\n    image: postgres:18@sha256:%064d\n' 0
    printf '  api:\n    image: ghcr.io/telflo/telflo/api:%s\n' "$1"
    printf '  web:\n    image: "ghcr.io/telflo/telflo/web:%s"\n' "$2"
  } >"$c/deploy/compose/compose.yaml"
}
# chart <version line> <appVersion line> [more lines]: the copy's Chart.yaml,
# shaped like the real one (a dependency's indented version line included,
# which must be ignored).
chart() {
  {
    printf 'apiVersion: v2\nname: telflo\ntype: application\n'
    printf '# The chart'"'"'s version and appVersion.\n'
    printf '%s\n' "$@"
    printf 'dependencies:\n  - name: opamp-server\n    version: 0.2.4\n    repository: oci://ghcr.io/telflo/charts\n'
  } >"$c/charts/telflo/Chart.yaml"
}
# check: run the copy's check; its output in $c.out (stdout and stderr), its
# exit status in $c.rc.
check() { (cd "$tmp" && bash "$c/scripts/release/check-version.sh" "$@") >"$c.out" 2>&1; echo $? >"$c.rc"; }
rc_is() { [ "$(cat "$c.rc")" = "$1" ]; }
said() { grep -qF -- "$1" "$c.out"; }

passes_with() { # <version>: every place the same version, unquoted and quoted
  fresh && chart "version: $1" "appVersion: \"$1\"" && compose "$1" "$1" && docs_at "$1" && check && rc_is 0 &&
    said "check-version: $1 in all 8 places"
}
fails_with() { # <version>: every place the same bad version; the failure names it
  fresh && chart "version: $1" "appVersion: \"$1\"" && compose "$1" "$1" && check && rc_is 1 &&
    said "charts/telflo/Chart.yaml's version is '$1', not a release version" &&
    said "charts/telflo/Chart.yaml's appVersion is '$1', not a release version"
}

echo "# the real tree"
real_tree() { (cd "$tmp" && bash "$REPO_DIR/scripts/release/check-version.sh") >"$tmp/real.out" 2>&1; }
run_case "the repository's own tree passes" real_tree

echo "# release versions pass"
for v in 0.1.0 0.1.12 1.0.0; do run_case "$v passes" passes_with "$v"; done
unquoted_app() { fresh && chart "version: 0.2.0" "appVersion: 0.2.0" && compose 0.2.0 0.2.0 && docs_at 0.2.0 && check && rc_is 0; }
run_case "an unquoted appVersion passes" unquoted_app
single_quoted() { fresh && chart "version: '0.2.0'" "appVersion: '0.2.0'  " && compose 0.2.0 0.2.0 && docs_at 0.2.0 && check && rc_is 0; }
run_case "single quotes and trailing blanks pass" single_quoted

echo "# anything else fails"
for v in 0.1.0-rc.1 0.1.0+1 v0.1.0 01.0.0 0.1 0.01.0 0.1.00 1.0.0.0 x0.1.0; do
  run_case "'$v' fails, named" fails_with "$v"
done
quoted_blank() { fresh && chart "version: \" 0.1.0\"" "appVersion: \"0.1.0 \"" && check && rc_is 1 &&
  said "version is ' 0.1.0', not a release version" && said "appVersion is '0.1.0 ', not a release version"; }
run_case "a blank inside the quotes fails" quoted_blank
empty_value() { fresh && chart "version:" "appVersion: \"\"" && check && rc_is 1 && said "not a release version"; }
run_case "an empty version fails" empty_value
no_app() { fresh && chart "version: 0.1.0" && check && rc_is 1 && said "charts/telflo/Chart.yaml's appVersion: missing"; }
run_case "a missing appVersion fails, named" no_app
twice() { fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" "version: 0.1.0" && check && rc_is 1 && said "charts/telflo/Chart.yaml's version: missing, or not exactly one"; }
run_case "a second top-level version line fails" twice
no_chart() { fresh && check && rc_is 1 && said "charts/telflo/Chart.yaml's version: missing"; }
run_case "no Chart.yaml fails" no_chart

echo "# one version everywhere"
differ() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.1\"" && compose 0.1.0 0.1.0 && check && rc_is 1 &&
    said "charts/telflo/Chart.yaml's appVersion (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "version 0.1.0 and appVersion 0.1.1 fail, naming both places and both values" differ

echo "# the Compose install"
compose_differs() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && compose 0.1.0 0.1.1 && check && rc_is 1 &&
    said "deploy/compose/compose.yaml:9's web image (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "a Compose image at another version fails, naming its line and both values" compose_differs
compose_bad() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && compose 0.1.0-rc.1 0.1.0 && check && rc_is 1 &&
    said "deploy/compose/compose.yaml:7's api image is '0.1.0-rc.1', not a release version"
}
run_case "a Compose image's tag that isn't a release version fails" compose_bad
compose_untagged() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && compose 0.1.0 0.1.0 &&
    printf '  telflo-extra:\n    image: ghcr.io/telflo/telflo/ottl-evaluator\n' >>"$c/deploy/compose/compose.yaml" &&
    check && rc_is 1 && said "deploy/compose/compose.yaml:11's ottl-evaluator image is '', not a release version"
}
run_case "a Compose image without a tag fails" compose_untagged
compose_none() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" &&
    printf 'name: telflo\nservices:\n  db:\n    image: postgres:18\n' >"$c/deploy/compose/compose.yaml" &&
    check && rc_is 1 && said "deploy/compose/compose.yaml's Telflo images: no image line names"
}
run_case "a compose.yaml naming no Telflo image fails" compose_none
compose_missing() {
  fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && check && rc_is 1 &&
    said "deploy/compose/compose.yaml: missing"
}
run_case "no deploy/compose/compose.yaml fails" compose_missing

echo "# the README's Quick start"
good() { fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && compose 0.1.0 0.1.0 && kube 0.1.0 0.1.0; }
readme_address_differs() {
  good && readme 0.1.1 0.1.0 && check && rc_is 1 &&
    said "README.md:5's download address (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "the Quick start's download address at another version fails, naming its line and both values" readme_address_differs
readme_archive_differs() {
  good && readme 0.1.0 0.1.1 && check && rc_is 1 &&
    said "README.md:7's archive name (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "the Quick start's archive name at another version fails, naming its line" readme_archive_differs
readme_placeholder() {
  good && readme '<version>' 0.1.0 && check && rc_is 1 &&
    said "README.md:5's download address is '', not a release version"
}
run_case "a placeholder for the version in the Quick start fails" readme_placeholder
readme_no_markers() {
  good && readme 0.1.0 0.1.0 && sed -i.bak '/quick-start:begin/d' "$c/README.md" && check && rc_is 1 &&
    said "README.md's Quick start: its markers aren't there once each, in order"
}
run_case "a README without its begin marker fails" readme_no_markers
readme_marker_twice() {
  good && readme 0.1.0 0.1.0 && printf '<!-- quick-start:end -->\n' >>"$c/README.md" && check && rc_is 1 &&
    said "README.md's Quick start: its markers aren't there once each, in order"
}
run_case "a README with its end marker twice fails" readme_marker_twice
readme_none() {
  good && printf '# Telflo\n<!-- quick-start:begin -->\nNothing to download.\n<!-- quick-start:end -->\n' >"$c/README.md" &&
    check && rc_is 1 && said "README.md's Quick start: no download address or archive name"
}
run_case "a Quick start naming no download fails" readme_none
readme_missing() { good && check && rc_is 1 && said "README.md: missing"; }
run_case "no README.md fails" readme_missing
# gh_note <version>: the private period's download, after the Quick start
# (line 11 of the copy's README.md).
gh_note() { printf 'While private: gh release download v%s -R telflo/telflo -p SHA256SUMS\n' "$1" >>"$c/README.md"; }
readme_gh_same() {
  good && readme 0.1.0 0.1.0 && gh_note 0.1.0 && check && rc_is 0 &&
    said "check-version: 0.1.0 in all 9 places" && said "README.md:11's gh release download"
}
run_case "a gh release download outside the Quick start at the version is a place, and passes" readme_gh_same
readme_gh_differs() {
  good && readme 0.1.0 0.1.0 && gh_note 0.1.1 && check && rc_is 1 &&
    said "README.md:11's gh release download (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "a gh release download at another version fails, naming its line and both values" readme_gh_differs
readme_gh_placeholder() {
  good && readme 0.1.0 0.1.0 && gh_note '<version>' && check && rc_is 1 &&
    said "README.md:11's gh release download is '', not a release version"
}
run_case "a placeholder for the version in a gh release download fails" readme_gh_placeholder

echo "# docs/kubernetes.md"
kube_chart_differs() {
  good && readme 0.1.0 0.1.0 && kube 0.1.1 0.1.0 && check && rc_is 1 &&
    said "docs/kubernetes.md:1's chart version (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "the chart's --version at another version fails, naming its line (another chart's ignored)" kube_chart_differs
kube_download_differs() {
  good && readme 0.1.0 0.1.0 && kube 0.1.0 0.1.1 && check && rc_is 1 &&
    said "docs/kubernetes.md:3's download address (0.1.1) differs from charts/telflo/Chart.yaml's version (0.1.0)"
}
run_case "the release download at another version fails, naming its line" kube_download_differs
kube_none() {
  good && readme 0.1.0 0.1.0 && printf 'helm install opamp oci://ghcr.io/telflo/charts/opamp-server --version 0.2.4\n' >"$c/docs/kubernetes.md" &&
    check && rc_is 1 && said "docs/kubernetes.md: no chart version"
}
run_case "a kubernetes.md naming neither the chart's version nor a download fails" kube_none
kube_missing() { good && readme 0.1.0 0.1.0 && rm "$c/docs/kubernetes.md" && check && rc_is 1 && said "docs/kubernetes.md: missing"; }
run_case "no docs/kubernetes.md fails" kube_missing

echo "# usage"
an_argument() { fresh && chart "version: 0.1.0" "appVersion: \"0.1.0\"" && compose 0.1.0 0.1.0 && check --tree . && rc_is 2; }
run_case "any argument is a usage error (exit 2)" an_argument

echo "# $passed passed, $failed failed"
[ "$failed" -eq 0 ]
