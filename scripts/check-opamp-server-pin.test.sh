#!/usr/bin/env bash
# Verifies scripts/check-opamp-server-pin.sh (D26 decision 36): it passes on
# the pinned state and fails, with its own message, when either half breaks:
# the sibling checkout (missing, not a checkout, a subfolder, the tag missing,
# moved, or only a branch of that name), the vendored files, the vendored
# chart (D33-1 decision 21: a changed, added or removed file, committed or
# not; a version that differs among the parent's dependency, the vendored
# Chart.yaml and the PIN; the PIN's chart-tree), the PIN, or compose's two
# services (as text, and as `docker compose config` reads them), and the
# same for the Compose install (deploy/compose/compose.yaml, read with its
# own folder as the project's and a placeholder env file; its bootstrap's
# own command; its copy of bootstrap.sql). Also --refresh both ways and
# --restore.
#
# Needs no network, no daemon and no opamp-server clone, but the docker CLI
# with its compose plugin for the cases where the check must pass or where
# only Compose's own reading catches the break: without it those cases print
# SKIP (the check fails closed without it, which a case shows), and the rest
# still run. Each case builds a
# throwaway sibling repository from the platform's vendored files (one
# commit, an annotated tag v<version>, the vendored chart at
# charts/opamp-server)
# and a throwaway platform beside it, a git repository with one commit,
# holding the script, the platform's docker-compose.yml with its pinned
# reference rewritten to a test digest, the vendored files, the platform
# chart's Chart.yaml and vendored chart, and a PIN naming that commit and
# that chart's tree (git's tree ids are its content's, so the throwaway
# chart's is the real PIN's). The version is the real PIN's, read from it,
# never written here (D36-1 decision 18), so a pin bump needs no edit here.
# Bash 3.2 runs it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PLATFORM=$(pwd)
SCRIPT="$PLATFORM/scripts/check-opamp-server-pin.sh"
COMPOSE_SRC="$PLATFORM/docker-compose.yml"
INSTALL_SRC="$PLATFORM/deploy/compose/compose.yaml"
VENDOR_SRC="$PLATFORM/vendor/opamp-server"
CHART_REL=charts/telflo/charts/opamp-server
CHART_SRC="$PLATFORM/$CHART_REL"
PARENT_SRC="$PLATFORM/charts/telflo/Chart.yaml"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/check-opamp-server-pin.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
PASSED=0
FAILURES=0
SKIPPED=0
HAVE_COMPOSE=
if docker compose version >/dev/null 2>&1; then HAVE_COMPOSE=1; fi
skip() {
  echo "SKIP: $1 (needs the docker CLI and its compose plugin)"
  SKIPPED=$((SKIPPED + 1))
}
ok() {
  echo "PASS: $1"
  PASSED=$((PASSED + 1))
}
bad() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}
g() { git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main -c tag.gpgSign=false -c commit.gpgSign=false "$@"; }
# Rewrites a file through a temporary copy (portable: no sed -i).
edit() {
  local file=$1
  shift
  "$@" <"$file" >"$file.new" && mv "$file.new" "$file"
}

# The pinned version (the real PIN's), and two others for the mismatch
# cases, never equal to it.
VERSION=$(sed -n 's/^version=\([0-9][0-9.]*\)$/\1/p' "$VENDOR_SRC/PIN")
if [ -z "$VERSION" ]; then
  echo "FAIL: vendor/opamp-server/PIN names no version"
  exit 1
fi
OTHER_VERSION=99.0.1
OTHER_VERSION2=99.0.2
if [ "$VERSION" = "$OTHER_VERSION" ] || [ "$VERSION" = "$OTHER_VERSION2" ]; then
  OTHER_VERSION=98.0.1
  OTHER_VERSION2=98.0.2
fi
# The version as a sed basic regular expression (its dots escaped).
VERSION_RE=$(printf '%s' "$VERSION" | sed 's/\./\\./g')
TAG="v$VERSION"
DIGEST=sha256:$(printf 'a test index' | shasum -a 256 | cut -d' ' -f1)
REF="ghcr.io/telflo/opamp-server:$VERSION@$DIGEST"

# The sibling: the vendored files at their paths in the server's repository.
mk_server() {
  local s="$WORK/opamp-server"
  rm -rf "$s"
  mkdir -p "$s/api" "$s/deploy" "$s/handlers/testdata"
  cp "$VENDOR_SRC/openapi.yaml" "$s/api/openapi.yaml"
  cp "$VENDOR_SRC/bootstrap.sql" "$s/deploy/bootstrap.sql"
  cp "$VENDOR_SRC/org-token-corpus.json" "$s/handlers/testdata/org-token-corpus.json"
  mkdir -p "$s/charts" && cp -R "$CHART_SRC" "$s/charts/opamp-server"
  g -C "$s" init -q && g -C "$s" add -A && g -C "$s" commit -q -m import &&
    g -C "$s" tag -a "$TAG" -m "$VERSION"
}
# The platform beside it.
mk_platform() {
  local p="$WORK/platform"
  rm -rf "$p"
  mkdir -p "$p/scripts" "$p/vendor/opamp-server"
  cp "$SCRIPT" "$p/scripts/check-opamp-server-pin.sh"
  sed "s#ghcr.io/telflo/opamp-server:[^[:space:]]*#$REF#" "$COMPOSE_SRC" >"$p/docker-compose.yml"
  mkdir -p "$p/deploy/compose/opamp-server"
  sed "s#ghcr.io/telflo/opamp-server:[^[:space:]]*#$REF#" "$INSTALL_SRC" >"$p/deploy/compose/compose.yaml"
  cp "$VENDOR_SRC/bootstrap.sql" "$p/deploy/compose/opamp-server/bootstrap.sql"
  cp "$VENDOR_SRC/openapi.yaml" "$VENDOR_SRC/bootstrap.sql" "$VENDOR_SRC/org-token-corpus.json" "$p/vendor/opamp-server/"
  mkdir -p "$p/charts/telflo/charts"
  cp "$PARENT_SRC" "$p/charts/telflo/Chart.yaml"
  cp -R "$CHART_SRC" "$p/$CHART_REL"
  printf 'version=%s\ncommit=%s\ndigest=%s\nchart-tree=%s\n' "$VERSION" \
    "$(git -C "$WORK/opamp-server" rev-parse "$TAG^{commit}")" "$DIGEST" \
    "$(git -C "$WORK/opamp-server" rev-parse "$TAG:charts/opamp-server")" >"$p/vendor/opamp-server/PIN"
  g -C "$p" init -q && g -C "$p" add -A && g -C "$p" commit -q -m platform
}
# Commits the throwaway platform's working tree as it is now.
commit_platform() { g -C "$WORK/platform" add -A && g -C "$WORK/platform" commit -q -m change; }
fresh() { mk_server && mk_platform; }
# Runs the copied script from / (so the default ../opamp-server must resolve
# against the platform's root, not the caller's directory), with
# OPAMP_SERVER_SRC only when $SRC is set.
run() {
  (cd / && env -u OPAMP_SERVER_SRC ${SRC:+OPAMP_SERVER_SRC="$SRC"} \
    "$WORK/platform/scripts/check-opamp-server-pin.sh" "$@") >"$WORK/out" 2>&1
}
expect_ok() {
  local name=$1
  shift
  if [ -z "$HAVE_COMPOSE" ]; then
    skip "$name"
  elif run "$@"; then ok "$name"; else bad "$name: $(cat "$WORK/out")"; fi
}
# A failure only Compose's own reading catches.
expect_compose_fail() {
  if [ -z "$HAVE_COMPOSE" ]; then skip "$1"; else expect_fail "$@"; fi
}
expect_fail() {
  local name=$1 msg=$2
  shift 2
  if run "$@"; then
    bad "$name: passed"
  elif grep -qF -- "$msg" "$WORK/out"; then
    ok "$name"
  else
    bad "$name: wrong message: $(cat "$WORK/out")"
  fi
}
V="$WORK/platform/vendor/opamp-server"
C="$WORK/platform/docker-compose.yml"
I="$WORK/platform/deploy/compose/compose.yaml"

# Preconditions: the platform's own compose names the image on exactly the
# two services' lines, so the rewritten copy is a fair pinned state.
if [ "$(grep -v '^[[:space:]]*#' "$COMPOSE_SRC" | grep -cF 'ghcr.io/telflo/opamp-server:')" = 2 ]; then
  ok "the platform's docker-compose.yml names the pinned image twice"
else
  bad "the platform's docker-compose.yml doesn't name the pinned image exactly twice"
fi
if [ "$(grep -v '^[[:space:]]*#' "$INSTALL_SRC" | grep -cF 'ghcr.io/telflo/opamp-server:')" = 2 ]; then
  ok "the Compose install's compose.yaml names the pinned image twice"
else
  bad "the Compose install's compose.yaml doesn't name the pinned image exactly twice"
fi

# The pinned state.
fresh
expect_ok "the pinned state passes, run from / (the default ../opamp-server is the platform root's sibling)"
fresh
SRC="$WORK/opamp-server" expect_ok "an absolute OPAMP_SERVER_SRC"
fresh
SRC="../opamp-server" expect_ok "a relative OPAMP_SERVER_SRC resolves against the platform's root"
fresh
printf '  # image: %s\n' "$REF" >>"$C"
expect_ok "a commented-out mention of the image doesn't count"

# The sibling.
fresh
mv "$WORK/opamp-server" "$WORK/elsewhere"
expect_fail "the checkout missing fails closed, naming the clone" "checkout $WORK/platform/../opamp-server is missing: clone the opamp-server's repository"
fresh
rm -rf "$WORK/opamp-server/.git"
expect_fail "a folder that isn't a checkout" "is not a git checkout"
fresh
SRC="$WORK/opamp-server/api" expect_fail "a folder inside a checkout" "is not the top of a git checkout"
fresh
(cd "$WORK/opamp-server" && printf 'x\n' >next.txt && g add next.txt && g commit -q -m next && g tag -f -a "$TAG" -m moved >/dev/null)
expect_fail "the tag moved off the PIN's commit" "but the PIN says"
fresh
g -C "$WORK/opamp-server" tag -d "$TAG" >/dev/null
expect_fail "the tag missing" "has no tag $TAG"
fresh
g -C "$WORK/opamp-server" tag -d "$TAG" >/dev/null
g -C "$WORK/opamp-server" branch "$TAG"
expect_fail "a branch named $TAG isn't the tag" "has no tag $TAG"
fresh
g -C "$WORK/opamp-server" tag -d "$TAG" >/dev/null
g -C "$WORK/opamp-server" tag "$TAG"
expect_ok "a lightweight tag at the PIN's commit counts"

# The vendored files.
fresh
printf ' ' >>"$V/openapi.yaml"
expect_fail "a changed vendored openapi.yaml" "openapi.yaml differs from $TAG's api/openapi.yaml"
fresh
printf '\n' >>"$V/bootstrap.sql"
expect_fail "a changed vendored bootstrap.sql" "bootstrap.sql differs from $TAG's deploy/bootstrap.sql"
fresh
edit "$V/org-token-corpus.json" tr -d '\n'
expect_fail "a changed vendored corpus" "org-token-corpus.json differs"
fresh
rm "$V/org-token-corpus.json"
expect_fail "a missing vendored corpus" "org-token-corpus.json is missing"
fresh
edit "$V/bootstrap.sql" awk '{ printf "%s\r\n", $0 }'
expect_fail "a vendored file with CRLF line endings" "bootstrap.sql differs"

# The PIN.
fresh
edit "$V/PIN" sed 's/^commit=.*/commit=abc/'
expect_fail "a malformed PIN (short commit)" "must be exactly four lines"
fresh
printf 'extra=1\n' >>"$V/PIN"
expect_fail "a PIN with a fourth line" "must be exactly four lines"
fresh
edit "$V/PIN" sed 's/^digest=sha256:/digest=sha512:/'
expect_fail "a PIN whose digest isn't sha256" "must be exactly four lines"
fresh
edit "$V/PIN" awk '{ printf "%s\r\n", $0 }'
expect_fail "a PIN with CRLF line endings" "must be exactly four lines"
fresh
edit "$V/PIN" awk 'NR == 1 { a = $0; next } NR == 2 { print; print a; next } { print }'
expect_fail "a PIN with its lines out of order" "must be exactly four lines"
fresh
printf 'version=%s\ncommit=%s\ndigest=%s\nchart-tree=%s' "$VERSION" "$(git -C "$WORK/opamp-server" rev-parse HEAD)" "$DIGEST" \
  "$(git -C "$WORK/opamp-server" rev-parse 'HEAD:charts/opamp-server')" >"$V/PIN"
expect_fail "a PIN without its final newline" "must be exactly four lines"
fresh
printf 'extra' >>"$V/PIN"
expect_fail "a PIN with a fourth line lacking its newline" "must be exactly four lines"
fresh
printf '# note' >>"$V/PIN"
expect_fail "a PIN with a comment line lacking its newline" "must be exactly four lines"
fresh
edit "$V/PIN" sed '/^chart-tree=/d'
expect_fail "a PIN without its chart-tree line (the three lines before D33-1)" "must be exactly four lines"
fresh
edit "$V/PIN" sed 's/^chart-tree=\(.\{39\}\).*/chart-tree=\1/'
expect_fail "a PIN whose chart-tree is short" "must be exactly four lines"
fresh
rm "$V/PIN"
expect_fail "a missing PIN" "PIN is missing"
fresh
other=$(printf '%040d' 0)
edit "$V/PIN" sed "s/^commit=.*/commit=$other/"
expect_fail "a PIN naming another commit" "but the PIN says $other"

# The vendored chart (D33-1 decision 21, Preflight ruling 5).
P="$WORK/platform"
VC="$P/$CHART_REL"
if [ "$(sed -n 's/^chart-tree=//p' "$VENDOR_SRC/PIN")" = "$(git -C "$PLATFORM" rev-parse 'HEAD:'"$CHART_REL" 2>/dev/null)" ]; then
  ok "the platform's own PIN chart-tree is its HEAD's vendored chart's tree"
else
  bad "the platform's own PIN chart-tree isn't its HEAD's vendored chart's tree"
fi
fresh
if [ "$(sed -n 's/^chart-tree=//p' "$V/PIN")" = "$(sed -n 's/^chart-tree=//p' "$VENDOR_SRC/PIN")" ]; then
  ok "the throwaway release's chart, copied from the vendored one, has the real PIN's chart-tree"
else
  bad "the throwaway release's chart has another tree id than the real PIN's chart-tree (a file's bytes or mode changed in the copy)"
fi
fresh
printf ' ' >>"$VC/values.yaml"
expect_fail "a changed vendored chart file, not committed" "the working tree's $CHART_REL differs from the PIN's chart-tree"
fresh
printf ' ' >>"$VC/templates/deployment.yaml"
commit_platform
expect_fail "a changed vendored chart file, committed" "HEAD's $CHART_REL is tree "
fresh
printf 'extra\n' >"$VC/templates/extra.yaml"
expect_fail "an added, untracked file in the vendored chart" "the working tree's $CHART_REL differs from the PIN's chart-tree"
fresh
rm "$VC/README.md"
expect_fail "a removed vendored chart file, not committed" "the working tree's $CHART_REL differs from the PIN's chart-tree"
fresh
chmod +x "$VC/files/initdb.sh"
expect_fail "a vendored chart file's mode changed (executable)" "the working tree's $CHART_REL differs from the PIN's chart-tree"
fresh
printf '.DS_Store\n' >"$P/.gitignore" && commit_platform && printf 'x' >"$VC/.DS_Store"
SRC="$WORK/opamp-server" expect_ok "an ignored .DS_Store in the vendored chart passes (Helm leaves it out too)"
fresh
printf '*.log\n.DS_Store\n' >"$P/.gitignore" && commit_platform && printf 'x' >"$VC/templates/debug.log"
expect_fail "any other file git ignores in the vendored chart fails (Helm would package it)" \
  "$CHART_REL/templates/debug.log is a file git ignores in the vendored chart"
fresh
rm -rf "$VC"
commit_platform
expect_fail "the vendored chart missing" "$CHART_REL is missing"
fresh
edit "$P/charts/telflo/Chart.yaml" sed "s/^    version: $VERSION_RE\$/    version: $OTHER_VERSION/"
grep -qxF "    version: $OTHER_VERSION" "$P/charts/telflo/Chart.yaml" || bad "the parent's dependency version couldn't be rewritten for its case"
expect_fail "the parent chart declaring another opamp-server version" "declares opamp-server $OTHER_VERSION, but the PIN says $VERSION"
fresh
edit "$P/charts/telflo/Chart.yaml" sed 's#^    repository: oci://ghcr.io/telflo/charts$#    repository: oci://ghcr.io/telflo/other#'
expect_fail "the parent chart's dependency at another repository" "not oci://ghcr.io/telflo/charts"
fresh
edit "$P/charts/telflo/Chart.yaml" sed '/^dependencies:/,$d'
expect_fail "the parent chart without the dependency" "must declare exactly one dependency named opamp-server"
fresh
edit "$P/charts/telflo/Chart.yaml" sed 's/^    name: opamp-server$/    name: "opamp-server"/'
SRC="$WORK/opamp-server" expect_ok "a quoted dependency name still counts"
fresh
edit "$VC/Chart.yaml" sed "s/^version: $VERSION_RE\$/version: $OTHER_VERSION2/"
grep -qxF "version: $OTHER_VERSION2" "$VC/Chart.yaml" || bad "the vendored Chart.yaml's version couldn't be rewritten for its case"
expect_fail "the vendored Chart.yaml's version differs from the PIN's" "Chart.yaml's version is '$OTHER_VERSION2', but the PIN says $VERSION"
fresh
edit "$V/PIN" sed "s/^chart-tree=.*/chart-tree=$(printf '%040d' 0)/"
expect_fail "a PIN naming another chart-tree than the release's" "$TAG's charts/opamp-server is tree "
fresh
(cd "$WORK/opamp-server" && g rm -r -q charts && g commit -q -m drop && g tag -f -a "$TAG" -m moved >/dev/null)
edit "$V/PIN" sed "s/^commit=.*/commit=$(git -C "$WORK/opamp-server" rev-parse HEAD)/"
expect_fail "a release without charts/opamp-server" "$TAG has no charts/opamp-server"
fresh
rm -rf "$WORK/outside" && mkdir -p "$WORK/outside"
mv "$VC" "$WORK/outside/opamp-server-chart" && ln -s "$WORK/outside/opamp-server-chart" "$VC"
expect_fail "a symlinked vendored chart" "$CHART_REL is a symbolic link"

# Symbolic links: refused before anything is read or written, so nothing
# outside vendor/opamp-server is written.
O="$WORK/outside"
fresh
rm -rf "$O" && mkdir -p "$O"
printf 'outside\n' >"$O/openapi.yaml"
rm "$V/openapi.yaml" && ln -s "$O/openapi.yaml" "$V/openapi.yaml"
expect_fail "a symlinked vendored file (check)" "vendor/opamp-server/openapi.yaml is a symbolic link"
expect_fail "a symlinked vendored file (--restore)" "vendor/opamp-server/openapi.yaml is a symbolic link" --restore
expect_fail "a symlinked vendored file (--refresh)" "vendor/opamp-server/openapi.yaml is a symbolic link" --refresh
if [ "$(cat "$O/openapi.yaml")" = outside ]; then ok "the symlinked file's target is untouched"; else bad "the symlinked file's target was written"; fi
fresh
rm -rf "$O" && mkdir -p "$O"
ln -s "$O/written" "$V/bootstrap.sql.tmp"
expect_fail "a symlinked .tmp (--restore)" "vendor/opamp-server/bootstrap.sql.tmp is a symbolic link" --restore
expect_fail "a symlinked .tmp (--refresh)" "vendor/opamp-server/bootstrap.sql.tmp is a symbolic link" --refresh
if [ ! -e "$O/written" ]; then ok "nothing is written through a symlinked .tmp"; else bad "a symlinked .tmp was written through"; fi
fresh
rm -rf "$O" && mkdir -p "$O"
mv "$V" "$O/vendor-opamp-server" && ln -s "$O/vendor-opamp-server" "$V"
printf ' ' >>"$O/vendor-opamp-server/openapi.yaml"
cp "$O/vendor-opamp-server/openapi.yaml" "$WORK/openapi.before"
expect_fail "a symlinked vendor/opamp-server (check)" "vendor/opamp-server is a symbolic link"
expect_fail "a symlinked vendor/opamp-server (--restore)" "vendor/opamp-server is a symbolic link" --restore
expect_fail "a symlinked vendor/opamp-server (--refresh)" "vendor/opamp-server is a symbolic link" --refresh
if cmp -s "$WORK/openapi.before" "$O/vendor-opamp-server/openapi.yaml" &&
  [ -z "$(find "$O/vendor-opamp-server" -name '*.tmp')" ]; then
  ok "nothing is written through a symlinked vendor/opamp-server"
else
  bad "a symlinked vendor/opamp-server was written through"
fi
fresh
rm -rf "$O" && mkdir -p "$O"
mv "$V/PIN" "$O/PIN" && ln -s "$O/PIN" "$V/PIN"
expect_fail "a symlinked PIN" "vendor/opamp-server/PIN is a symbolic link"

# Compose.
fresh
edit "$C" awk -v ref="$REF" 'index($0, ref) && !done { sub(/@sha256:[0-9a-f]*/, "@sha256:" sprintf("%064d", 0)); done = 1 } { print }'
expect_fail "a compose image line with another digest" "image is 'ghcr.io/telflo/opamp-server:$VERSION@sha256:$(printf '%064d' 0)'"
fresh
edit "$C" awk -v ref="$REF" -v from=":$VERSION@" -v to=":$OTHER_VERSION@" \
  'index($0, ref) && !done { i = index($0, from); $0 = substr($0, 1, i - 1) to substr($0, i + length(from)); done = 1 } { print }'
grep -qF ":$OTHER_VERSION@" "$C" || bad "a compose image line's version couldn't be rewritten for its case"
expect_fail "a compose image line with another version" "not the PIN's $REF"
fresh
edit "$C" awk '$0 == "  opamp-server:" { print; print "    build: ../opamp-server"; next } { print }'
expect_fail "a build: left on opamp-server" "opamp-server has a build:"
fresh
edit "$C" awk '$0 == "  opamp-migrate:" { print; print "    build: { context: ../opamp-server }"; next } { print }'
expect_fail "a build: left on opamp-migrate" "opamp-migrate has a build:"
fresh
edit "$C" awk -v ref="$REF" 'index($0, ref) && !done { done = 1; next } { print }'
expect_fail "a service without its image line" "<0 image lines>"
fresh
edit "$C" awk -v ref="$REF" 'index($0, ref) && !done { print; print; done = 1; next } { print }'
expect_fail "a service with two image lines" "<2 image lines>"
for service in opamp-migrate opamp-server; do
  fresh
  { printf 'x-opamp-build: &opamp-build\n  build: ../opamp-server\n'; cat "$C"; } >"$C.new" && mv "$C.new" "$C"
  edit "$C" awk -v svc="  $service:" '$0 == svc { print; print "    <<: *opamp-build"; next } { print }'
  expect_fail "a YAML merge key in $service" "$service has a YAML merge key"
done
# What only Compose's own reading sees: a tagged merge key (!!merge <<:)
# passes the text layer; a quoted "<<" isn't a merge key (Compose merges
# nothing), so under an extension field it passes and as a service's key
# Compose refuses the file.
for service in opamp-migrate opamp-server; do
  fresh
  { printf 'x-b: &b\n  build: ../opamp-server\n'; cat "$C"; } >"$C.new" && mv "$C.new" "$C"
  edit "$C" awk -v svc="  $service:" '$0 == svc { print; print "    !!merge <<: *b"; next } { print }'
  expect_compose_fail "a tagged merge key (!!merge <<:) bringing a build: into $service" "as Compose reads docker-compose.yml (docker compose config): $service has a build"
done
fresh
{ printf 'x-b: &b\n  build: ../opamp-server\n'; cat "$C"; } >"$C.new" && mv "$C.new" "$C"
edit "$C" awk '$0 == "  opamp-server:" { print; print "    x-note:"; print "      \"<<\": *b"; next } { print }'
expect_ok "a quoted \"<<\" under an extension field merges nothing and passes"
fresh
{ printf 'x-b: &b\n  build: ../opamp-server\n'; cat "$C"; } >"$C.new" && mv "$C.new" "$C"
edit "$C" awk '$0 == "  opamp-server:" { print; print "    \"<<\": *b"; next } { print }'
expect_compose_fail "a quoted \"<<\" as a service's key: Compose refuses the file" "docker compose config refused docker-compose.yml"
# The root's compose files are an allowlist, and Compose's own discovery
# (what a plain `docker compose` in the root reads) is verified too.
fresh
cp "$PLATFORM/docker-compose.opamp-server-dev.yml" "$WORK/platform/"
expect_ok "docker-compose.opamp-server-dev.yml beside docker-compose.yml passes"
fresh
sed "s#$REF#ghcr.io/telflo/opamp-server:$OTHER_VERSION@$DIGEST#" "$C" >"$WORK/platform/compose.yaml"
expect_fail "a root compose.yaml with another image" "compose.yaml at the platform's root isn't one of its compose files"
fresh
printf 'services:\n  opamp-server:\n    build: ../opamp-server\n' >"$WORK/platform/docker-compose.override.yml"
if run; then
  bad "a root docker-compose.override.yml merging a build: passed"
elif grep -qF "docker-compose.override.yml at the platform's root isn't one of its compose files" "$WORK/out"; then
  ok "a root docker-compose.override.yml merging a build is refused (by the allowlist)"
elif grep -qF "as Compose reads the root's compose files (Compose's own discovery, as a plain docker compose there) (docker compose config): opamp-server has a build" "$WORK/out"; then
  ok "a root docker-compose.override.yml merging a build is refused (by Compose's discovery)"
else
  bad "a root docker-compose.override.yml merging a build: wrong message: $(cat "$WORK/out")"
fi
# The allowlist compares names case-insensitively (macOS's filesystem is:
# Compose reads Compose.yaml as compose.yaml).
fresh
sed "s#$REF#ghcr.io/telflo/opamp-server:$OTHER_VERSION@$DIGEST#" "$C" >"$WORK/platform/Compose.yaml"
expect_fail "a root Compose.yaml" "Compose.yaml at the platform's root isn't one of its compose files"
fresh
sed "s#$REF#ghcr.io/telflo/opamp-server:$OTHER_VERSION@$DIGEST#" "$C" >"$WORK/platform/COMPOSE.YML"
expect_fail "a root COMPOSE.YML" "COMPOSE.YML at the platform's root isn't one of its compose files"
fresh
printf 'services:\n  opamp-server:\n    build: ../opamp-server\n' >"$WORK/platform/Docker-Compose.Override.yml"
expect_fail "a root Docker-Compose.Override.yml" "Docker-Compose.Override.yml at the platform's root isn't one of its compose files"
# The discovery run's own cases: no file name the allowlist allows is one
# Compose's discovery reads differently, so these run a test-only copy of the
# script with the allowlist's one call removed, and show the discovery run
# alone still refuses what a plain docker compose in the root would read.
stub_allowlist() {
  local stubbed="$WORK/stubbed.sh"
  sed '/^  check_root_compose_files$/d' "$SCRIPT" >"$stubbed"
  [ "$(($(wc -l <"$SCRIPT") - $(wc -l <"$stubbed")))" = 1 ] || return 1
  cp "$stubbed" "$WORK/platform/scripts/check-opamp-server-pin.sh"
}
: >"$WORK/CaseProbe"
CASE_INSENSITIVE=
if [ -e "$WORK/caseprobe" ]; then CASE_INSENSITIVE=1; fi
rm -f "$WORK/CaseProbe"
fresh
if ! stub_allowlist; then
  bad "the allowlist's call couldn't be removed from a copy of the script"
else
  printf 'services:\n  opamp-server:\n    build: ../opamp-server\n' >"$WORK/platform/docker-compose.override.yml"
  expect_compose_fail "the allowlist stubbed out: Compose's discovery alone refuses a docker-compose.override.yml merging a build" "as Compose reads the root's compose files (Compose's own discovery, as a plain docker compose there) (docker compose config): opamp-server has a build"
fi
fresh
if [ -z "$CASE_INSENSITIVE" ]; then
  echo "SKIP: the allowlist stubbed out, a root Compose.yaml (needs a case-insensitive filesystem)"
  SKIPPED=$((SKIPPED + 1))
elif ! stub_allowlist; then
  bad "the allowlist's call couldn't be removed from a copy of the script"
else
  sed "s#$REF#ghcr.io/telflo/opamp-server:$OTHER_VERSION@$DIGEST#" "$C" >"$WORK/platform/Compose.yaml"
  expect_compose_fail "the allowlist stubbed out: Compose's discovery alone refuses a root Compose.yaml with another image" "as Compose reads the root's compose files (Compose's own discovery, as a plain docker compose there) (docker compose config): opamp-migrate's image is"
fi
# The bootstrap mounts the vendored bootstrap.sql, as Compose reads it.
fresh
printf 'select 1;\n' >"$WORK/platform/other.sql"
edit "$C" sed 's#\./vendor/opamp-server/bootstrap\.sql:/opamp/bootstrap\.sql#./other.sql:/opamp/bootstrap.sql#'
expect_compose_fail "the bootstrap mounting another file at /opamp/bootstrap.sql" "opamp-bootstrap mounts '$WORK/platform/other.sql' at /opamp/bootstrap.sql, not vendor/opamp-server/bootstrap.sql"
fresh
edit "$C" sed 's#\./vendor/opamp-server/bootstrap\.sql:/opamp/bootstrap\.sql#./vendor/opamp-server/bootstrap.sql:/opamp/other.sql#'
expect_compose_fail "the bootstrap without its mount at /opamp/bootstrap.sql" "opamp-bootstrap has 0 mounts at /opamp/bootstrap.sql"
fresh
printf 'select 1;\n' >"$WORK/platform/vendor/opamp-server/other.sql"
edit "$C" sed 's#"-f", "/opamp/bootstrap.sql"\]#"-f", "/opamp/other.sql"]#'
grep -qF '"-f", "/opamp/other.sql"]' "$C" || bad "the bootstrap's command couldn't be rewritten for its case"
expect_compose_fail "the bootstrap's command running another file" "opamp-bootstrap's command is"
# The command must equal the committed list exactly, and there must be no
# entrypoint.
if [ -z "$HAVE_COMPOSE" ]; then
  skip "the script's BOOTSTRAP_COMMAND is docker-compose.yml's bootstrap command"
else
  mkdir -p "$WORK/dc"
  python3 -I -c 'import json, os, sys
plugins = sys.argv[1]
json.dump({"cliPluginsExtraDirs": [plugins]} if os.path.isdir(plugins) else {}, open(sys.argv[2], "w"))' \
    "${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}/cli-plugins" "$WORK/dc/config.json"
  expected_line=$(sed -n "s/^BOOTSTRAP_COMMAND='\(.*\)'\$/\1/p" "$SCRIPT")
  if (cd "$PLATFORM" && env -u DOCKER_CONTEXT -u COMPOSE_FILE DOCKER_CONFIG="$WORK/dc" docker compose -p opamp-pin-check \
    --project-directory "$PLATFORM" --env-file /dev/null -f "$COMPOSE_SRC" config --format json) 2>/dev/null |
    python3 -I -c 'import json, sys
committed = json.load(sys.stdin)["services"]["opamp-bootstrap"]["command"]
sys.exit(0 if sys.argv[1] and committed == json.loads(sys.argv[1]) else 1)' "$expected_line"; then
    ok "the script's BOOTSTRAP_COMMAND is docker-compose.yml's bootstrap command"
  else
    bad "the script's BOOTSTRAP_COMMAND differs from docker-compose.yml's bootstrap command: update one"
  fi
fi
fresh
edit "$C" sed 's#"-f", "/opamp/bootstrap.sql"\]#"-f", "/opamp/bootstrap.sql", "-f", "/opamp/other.sql"]#'
grep -qF '"-f", "/opamp/other.sql"]' "$C" || bad "the bootstrap's command couldn't be rewritten for its case"
expect_compose_fail "the bootstrap's command with a second -f" "opamp-bootstrap's command is"
fresh
edit "$C" awk '$0 == "  opamp-bootstrap:" { print; print "    entrypoint: [\"sh\", \"-c\", \"true\"]"; next } { print }'
expect_compose_fail "the bootstrap with an entrypoint" "opamp-bootstrap has an entrypoint"
fresh
edit "$C" awk '/^    command: \["psql", "-h", "db"/ { print "    command: \"psql -h db -U telflo_platform_owner -d postgres -X -q -v ON_ERROR_STOP=1 -f /opamp/bootstrap.sql\""; getline; next } { print }'
grep -qF 'command: "psql -h db' "$C" || bad "the bootstrap's command couldn't be rewritten in string form"
expect_ok "the bootstrap's exact command in string form passes"
# The local image's revision label, through a stand-in docker that answers
# `image inspect` (and hands everything else to the real docker).
mkdir -p "$WORK/bin"
REAL_DOCKER=$(command -v docker || true)
cat >"$WORK/bin/docker" <<STANDIN
#!/bin/sh
if [ "\$1" = image ] && [ "\$2" = inspect ]; then
  for last in "\$@"; do :; done
  printf '%s %s\\n' "\$(basename "\${DOCKER_CONFIG:-none}")" "\$last" >>"$WORK/inspect.log"
  case "\$PIN_TEST_INSPECT" in
    match) echo "\$PIN_TEST_REVISION"; exit 0 ;;
    mismatch) echo 0000000000000000000000000000000000000000; exit 0 ;;
    *) echo "Error: No such image: \$last" >&2; exit 1 ;;
  esac
fi
exec "$REAL_DOCKER" "\$@"
STANDIN
chmod +x "$WORK/bin/docker"
inspect_case() {
  local name=$1 mode=$2 expect=$3 status
  if [ -z "$HAVE_COMPOSE" ]; then
    skip "$name"
    return
  fi
  fresh
  : >"$WORK/inspect.log"
  if PIN_TEST_INSPECT=$mode PIN_TEST_REVISION=$(git -C "$WORK/opamp-server" rev-parse HEAD) PATH="$WORK/bin:$PATH" \
    run; then status=0; else status=1; fi
  if [ "$expect" = fail ] && [ "$status" = 0 ]; then
    bad "$name: passed"
  elif [ "$expect" != fail ] && [ "$status" != 0 ]; then
    bad "$name: $(cat "$WORK/out")"
  elif ! grep -qF -- "$4" "$WORK/out"; then
    bad "$name: wrong message: $(cat "$WORK/out")"
  elif ! grep -qE "^check-opamp-server-pin\.[A-Za-z0-9]+ $REF\$" "$WORK/inspect.log"; then
    bad "$name: docker image inspect wasn't asked about the PIN's reference through a temporary config: $(cat "$WORK/inspect.log")"
  else
    ok "$name"
  fi
}
inspect_case "the local image's revision label is the PIN's commit" match ok "the local image's revision label is "
inspect_case "the local image's revision label isn't the PIN's commit" mismatch fail "has revision label '0000000000000000000000000000000000000000', but the PIN says"
inspect_case "the image isn't local: its revision isn't checked, and that isn't a failure" absent ok "isn't in the local Docker store, so its revision label wasn't checked"
# Without the docker CLI the check fails closed, naming why.
fresh
no_docker_path=
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] && [ -x "$dir/docker" ] && continue
  no_docker_path="${no_docker_path:+$no_docker_path:}$dir"
done
IFS=$old_ifs
if ! PATH="$no_docker_path" command -v git >/dev/null 2>&1; then
  echo "SKIP: without docker on PATH (git shares docker's folder here)"
  SKIPPED=$((SKIPPED + 1))
elif (PATH="$no_docker_path" && export PATH && run); then
  bad "without docker on PATH: passed"
elif grep -qF "docker isn't on PATH" "$WORK/out"; then
  ok "without docker on PATH the check fails closed, naming why"
else
  bad "without docker on PATH: wrong message: $(cat "$WORK/out")"
fi
fresh
printf '  extra:\n    image: %s\n' "$REF" >>"$C"
expect_fail "a third service naming the image" "names ghcr.io/telflo/opamp-server 3 times outside comments"
fresh
edit "$C" sed 's#^  opamp-server:$#  opamp-server-renamed:#'
expect_fail "a renamed service" "opamp-server image is '<0 image lines>'"
fresh
rm "$C"
expect_fail "compose missing" "docker-compose.yml is missing"

# The Compose install (D36-2 decisions 88 and 89; Preflight ruling 1).
fresh
edit "$I" awk -v ref="$REF" 'index($0, ref) && !done { sub(/@sha256:[0-9a-f]*/, "@sha256:" sprintf("%064d", 0)); done = 1 } { print }'
expect_fail "the install's image line with another digest" "deploy/compose/compose.yaml's opamp-migrate image is 'ghcr.io/telflo/opamp-server:$VERSION@sha256:$(printf '%064d' 0)'"
fresh
edit "$I" awk '$0 == "  opamp-server:" { print; print "    build: ../opamp-server"; next } { print }'
expect_fail "a build: on the install's opamp-server" "deploy/compose/compose.yaml's opamp-server has a build:"
fresh
{ printf 'x-b: &b\n  build: ../opamp-server\n'; cat "$I"; } >"$I.new" && mv "$I.new" "$I"
edit "$I" awk '$0 == "  opamp-migrate:" { print; print "    !!merge <<: *b"; next } { print }'
expect_compose_fail "a tagged merge key bringing a build: into the install's opamp-migrate" "as Compose reads deploy/compose/compose.yaml (docker compose config): opamp-migrate has a build"
fresh
printf '  extra:\n    image: %s\n' "$REF" >>"$I"
expect_fail "a third service in the install naming the image" "deploy/compose/compose.yaml names ghcr.io/telflo/opamp-server 3 times outside comments"
fresh
printf '\n' >>"$WORK/platform/deploy/compose/opamp-server/bootstrap.sql"
expect_fail "the install's copy of bootstrap.sql changed" "deploy/compose/opamp-server/bootstrap.sql differs from $TAG's deploy/bootstrap.sql"
fresh
rm "$WORK/platform/deploy/compose/opamp-server/bootstrap.sql"
expect_fail "the install's copy of bootstrap.sql missing" "deploy/compose/opamp-server/bootstrap.sql is missing"
fresh
rm "$I"
expect_fail "the install's compose.yaml missing" "deploy/compose/compose.yaml is missing"
fresh
rm -rf "$O" && mkdir -p "$O"
mv "$I" "$O/compose.yaml" && ln -s "$O/compose.yaml" "$I"
expect_fail "a symlinked install compose.yaml" "deploy/compose/compose.yaml is a symbolic link"
fresh
edit "$I" sed 's#"-U", "postgres", "-d", "postgres"#"-U", "telflo_platform_owner", "-d", "postgres"#'
grep -qF '"-U", "telflo_platform_owner", "-d", "postgres"' "$I" || bad "the install's bootstrap command couldn't be rewritten for its case"
expect_compose_fail "the install's bootstrap with the development stack's command (-U telflo_platform_owner)" "db-bootstrap's command is"
fresh
edit "$I" sed 's#"-f", "/telflo/telflo-bootstrap.sql", "-f", "/opamp/bootstrap.sql"\]#"-f", "/opamp/bootstrap.sql"]#'
grep -qF '"ON_ERROR_STOP=1", "-f", "/opamp/bootstrap.sql"]' "$I" || bad "the install's bootstrap command couldn't be shortened for its case"
expect_compose_fail "the install's bootstrap without the chart's telflo-bootstrap.sql" "db-bootstrap's command is"
fresh
edit "$I" sed 's#\./opamp-server/bootstrap\.sql:/opamp/bootstrap\.sql#../../vendor/opamp-server/bootstrap.sql:/opamp/bootstrap.sql#'
grep -qF '../../vendor/opamp-server/bootstrap.sql:/opamp/bootstrap.sql' "$I" || bad "the install's bootstrap mount couldn't be rewritten for its case"
expect_compose_fail "the install's bootstrap mounting a file outside its folder" "db-bootstrap mounts '$WORK/platform/vendor/opamp-server/bootstrap.sql' at /opamp/bootstrap.sql, not deploy/compose/opamp-server/bootstrap.sql"
fresh
edit "$I" awk '$0 == "  db-bootstrap:" { print; print "    entrypoint: [\"sh\", \"-c\", \"true\"]"; next } { print }'
expect_compose_fail "the install's bootstrap with an entrypoint" "db-bootstrap has an entrypoint"
fresh
printf 'TELFLO_API_PASSWORD=x\n' >"$WORK/platform/deploy/compose/.env"
chmod 600 "$WORK/platform/deploy/compose/.env"
SRC="$WORK/opamp-server" expect_ok "an install .env beside compose.yaml is never read (the placeholder env file is)"
# The script's INSTALL_BOOTSTRAP_COMMAND is the committed compose.yaml's.
if [ -z "$HAVE_COMPOSE" ]; then
  skip "the script's INSTALL_BOOTSTRAP_COMMAND is deploy/compose/compose.yaml's bootstrap command"
else
  mkdir -p "$WORK/dc"
  python3 -I -c 'import json, os, sys
plugins = sys.argv[1]
json.dump({"cliPluginsExtraDirs": [plugins]} if os.path.isdir(plugins) else {}, open(sys.argv[2], "w"))' \
    "${DOCKER_CONFIG:-${HOME:-/nonexistent}/.docker}/cli-plugins" "$WORK/dc/config.json"
  grep -oE '[$][{][A-Z_][A-Z0-9_]*:[?]' "$INSTALL_SRC" | sed 's/^[$][{]//; s/:[?]$//' | sort -u |
    while read -r name; do
      case "$name" in *_PORT) echo "$name=1" ;; *_ADDRESS) echo "$name=127.0.0.1" ;; *) echo "$name=placeholder" ;; esac
    done >"$WORK/install.env"
  install_line=$(sed -n "s/^INSTALL_BOOTSTRAP_COMMAND='\(.*\)'\$/\1/p" "$SCRIPT")
  if (cd "$PLATFORM" && env -u DOCKER_CONTEXT -u COMPOSE_FILE -u COMPOSE_PROFILES DOCKER_CONFIG="$WORK/dc" docker compose -p opamp-pin-check \
    --project-directory "$PLATFORM/deploy/compose" --env-file "$WORK/install.env" -f "$INSTALL_SRC" config --format json) 2>/dev/null |
    python3 -I -c 'import json, sys
committed = json.load(sys.stdin)["services"]["db-bootstrap"]["command"]
sys.exit(0 if sys.argv[1] and committed == json.loads(sys.argv[1]) else 1)' "$install_line"; then
    ok "the script's INSTALL_BOOTSTRAP_COMMAND is deploy/compose/compose.yaml's bootstrap command"
  else
    bad "the script's INSTALL_BOOTSTRAP_COMMAND differs from deploy/compose/compose.yaml's bootstrap command: update one"
  fi
fi

# --refresh.
fresh
printf ' ' >>"$WORK/opamp-server/api/openapi.yaml"
if run --refresh && grep -qF "no longer matches" "$WORK/out" &&
  cmp -s "$WORK/opamp-server/api/openapi.yaml" "$V/openapi.yaml" && ! run; then
  ok "--refresh copies a changed working tree, says the PIN no longer matches, and the check then fails"
else
  bad "--refresh (changed): $(cat "$WORK/out")"
fi
fresh
if [ -z "$HAVE_COMPOSE" ]; then
  skip "--refresh with an unchanged working tree keeps the PIN matching"
elif run --refresh && grep -qF "so the PIN still matches" "$WORK/out" && run; then
  ok "--refresh with an unchanged working tree keeps the PIN matching"
else
  bad "--refresh (unchanged): $(cat "$WORK/out")"
fi
fresh
rm "$WORK/opamp-server/deploy/bootstrap.sql"
cp "$V/openapi.yaml" "$WORK/openapi.before"
printf ' ' >>"$WORK/opamp-server/api/openapi.yaml"
if ! run --refresh && grep -qF "deploy/bootstrap.sql is missing" "$WORK/out" &&
  cmp -s "$WORK/openapi.before" "$V/openapi.yaml"; then
  ok "--refresh with a file missing from the working tree copies nothing"
else
  bad "--refresh (missing file): $(cat "$WORK/out")"
fi

# --restore.
fresh
printf ' ' >>"$V/openapi.yaml"
rm "$V/bootstrap.sql"
if [ -z "$HAVE_COMPOSE" ]; then
  skip "--restore writes the PIN commit's files back and the check passes"
elif run --restore && grep -qF "wrote $TAG's three files back" "$WORK/out" &&
  grep -qF "OK: $TAG" "$WORK/out" && run; then
  ok "--restore writes the PIN commit's files back and the check passes"
else
  bad "--restore: $(cat "$WORK/out")"
fi
fresh
printf ' ' >>"$WORK/opamp-server/api/openapi.yaml"
run --refresh
if [ -z "$HAVE_COMPOSE" ]; then
  skip "--restore after --refresh is the way back to the pin"
elif run --restore && run; then
  ok "--restore after --refresh is the way back to the pin"
else
  bad "--restore after --refresh: $(cat "$WORK/out")"
fi
fresh
printf ' ' >>"$V/openapi.yaml"
cp "$V/openapi.yaml" "$WORK/openapi.before"
(cd "$WORK/opamp-server" && printf 'x\n' >next.txt && g add next.txt && g commit -q -m next && g tag -f -a "$TAG" -m moved >/dev/null)
if ! run --restore && grep -qF "but the PIN says" "$WORK/out" && cmp -s "$WORK/openapi.before" "$V/openapi.yaml"; then
  ok "--restore with the tag moved fails and writes nothing"
else
  bad "--restore (tag moved): $(cat "$WORK/out")"
fi
fresh
printf ' ' >>"$V/openapi.yaml"
edit "$C" awk '$0 == "  opamp-server:" { print; print "    build: ../opamp-server"; next } { print }'
expect_fail "--restore still checks compose" "has a build:" --restore

fresh
(cd "$WORK/opamp-server" && g rm -q handlers/testdata/org-token-corpus.json && g commit -q -m drop &&
  g tag -f -a "$TAG" -m moved >/dev/null)
edit "$V/PIN" sed "s/^commit=.*/commit=$(git -C "$WORK/opamp-server" rev-parse HEAD)/"
if ! run --restore && grep -qF "couldn't read $TAG's handlers/testdata/org-token-corpus.json" "$WORK/out" &&
  [ -z "$(find "$V" -name '*.tmp')" ]; then
  ok "a failed --restore leaves no .tmp behind"
else
  bad "--restore (blob missing): $(cat "$WORK/out"); $(ls "$V")"
fi

# A .tmp left there, hard-linked to a file outside, is replaced, never
# written into.
for mode in --restore --refresh; do
  fresh
  rm -rf "$O" && mkdir -p "$O"
  printf 'outside\n' >"$O/hard"
  ln "$O/hard" "$V/bootstrap.sql.tmp"
  run "$mode"
  if [ "$(cat "$O/hard")" = outside ] && [ ! -e "$V/bootstrap.sql.tmp" ] &&
    cmp -s "$WORK/opamp-server/deploy/bootstrap.sql" "$V/bootstrap.sql"; then
    ok "$mode replaces a hard-linked .tmp; the file outside is unchanged"
  else
    bad "$mode with a hard-linked .tmp: $(cat "$WORK/out")"
  fi
done

# Arguments.
fresh
expect_fail "an unknown argument" "usage" --bogus
fresh
expect_fail "two arguments" "usage" --refresh --restore

echo "passed $PASSED, failed $FAILURES, skipped $SKIPPED"
[ "$FAILURES" = 0 ]
