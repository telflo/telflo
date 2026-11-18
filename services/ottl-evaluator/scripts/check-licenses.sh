#!/usr/bin/env bash
# Fails if any Go module this service builds on carries a license that does
# not allow redistribution. telflo ships the ottl-evaluator too, so its Go
# dependencies follow the same rule as the npm ones. As the opamp-server's
# scripts/check-licenses.sh, with one addition (D15a spec decision 4,
# Preflight ruling 3): the policy's "goModules" names reviewed MPL-2.0
# modules, each at one version.
# Only licenses on the policy's allowed list pass (ADR 0019, amended by D15a).
#
# Usage: scripts/check-licenses.sh [license-policy.json] [module-dir]
#
#   license-policy.json  the allowed list and the named modules; defaults to
#                        the platform's scripts/license-policy.json, two
#                        levels above this service. An argument, so that D26
#                        can vendor the file when the service moves to its own
#                        repository.
#   module-dir           the Go module to check; defaults to this service.
#                        The self-test points it at its fixtures.
#
# Builds go-licenses (pinned) natively into a temporary directory, then runs
# it over every package in the module (./...), leaving out the module's own
# packages, which carry no LICENSE until the service is published, once for
# each platform the image is built for, linux/amd64 and linux/arm64 (GOOS and
# GOARCH set, CGO_ENABLED=0 as the Dockerfile builds), and checks the union:
# a module that only one platform's build pulls in (klauspost/cpuid/v2,
# through zeebo/xxh3, on amd64 only) is checked whichever machine runs this.
# (`go run` under a target GOOS would build go-licenses itself for that
# target, which can't run here.) go-licenses follows the packages'
# non-test imports only, so it checks what the binary ships: a module that
# only tests import (kin-openapi, for the OpenAPI conformance test) is never
# shipped, and isn't checked here. Every module it reports must carry a
# license on the policy's "allowed" list, with one exception: a license of
# exactly MPL-2.0 passes when the module, at the version the build uses, is
# named in the policy's "goModules" ("module@version": "reason"). The same
# module at another version fails, so does a module replaced by a local
# directory (its code isn't the reviewed release), and so does any other
# license outside "allowed", named or not. One that go-licenses can't
# classify ("Unknown") fails too, since an unknown license can't be shown to
# be redistributable. The policy's "exceptions" name npm packages and are
# not read here.
#
# Exits 0 when every license is allowed, 1 when one isn't, 2 when the check
# itself can't run.
set -euo pipefail

GO_LICENSES="github.com/google/go-licenses/v2@v2.0.1"
OWN_MODULE="github.com/telflo/ottl-evaluator"
# The platforms the image is built for (Docker's linux/amd64 and
# linux/arm64): each one's dependencies are checked.
TARGETS="linux/amd64 linux/arm64"
# The only license goModules can admit.
NAMED_LICENSE="MPL-2.0"
# go.mod's toolchain line is the one CI and every developer use; never let
# go run download a newer one.
export GOTOOLCHAIN=local

service_dir=$(cd "$(dirname "$0")/.." && pwd)
policy=${1:-$service_dir/../../scripts/license-policy.json}
module_dir=${2:-$service_dir}

if [ ! -f "$policy" ]; then
  echo "ERROR: no license policy at $policy" >&2
  exit 2
fi
if [ ! -f "$module_dir/go.mod" ]; then
  echo "ERROR: no go.mod in $module_dir" >&2
  exit 2
fi

if ! allowed=$(jq -er '.allowed[]' "$policy"); then
  echo "ERROR: $policy has no \"allowed\" list" >&2
  exit 2
fi
# goModules is optional; when present, it is an object whose every entry but
# "$comment" maps "module@version" (a version starting with v) to a reason.
if ! named=$(jq -r '
    (.goModules // {}) as $named
    | if ($named | type) != "object" then error("goModules is not an object")
      else $named | to_entries[] | select(.key != "$comment")
        | if (.key | test("^[^@\\s]+@v[^@\\s]+$")) and (.value | type) == "string" and (.value | length) > 0
          then .key else error("a bad goModules entry") end
      end' "$policy" 2>/dev/null); then
  echo "ERROR: $policy's \"goModules\" must map \"module@version\" to a reason" >&2
  exit 2
fi

# go-licenses logs warnings and download progress on stderr; keep them out
# of the way unless the tool itself fails.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stderr_log="$work/stderr"

# go-licenses, built for this machine (no GOOS or GOARCH from the caller),
# outside any module, so the module under check doesn't pick its
# dependencies.
if ! (cd "$work" && env -u GOOS -u GOARCH GOBIN="$work/bin" go install "$GO_LICENSES") 2>"$stderr_log"; then
  cat "$stderr_log" >&2
  echo "ERROR: go-licenses couldn't be built" >&2
  exit 2
fi

# Each package the binary is built from, with its module and the version the
# build uses: "import-path module@version", the replacement's module@version
# for a module replaced by another release, "import-path
# module@version(replaced-by-a-directory)" for one replaced by a local
# directory (never a name goModules can hold), and "import-path module@" for
# the main module.
list_format='{{if .Module}}{{.ImportPath}} {{with .Module.Replace}}{{if .Version}}{{.Path}}@{{.Version}}{{else}}{{$.Module.Path}}@{{$.Module.Version}}(replaced-by-a-directory){{end}}{{else}}{{.Module.Path}}@{{.Module.Version}}{{end}}{{end}}'

report=""
packages=""
for target in $TARGETS; do
  goos=${target%/*}
  goarch=${target#*/}
  if ! target_report=$(cd "$module_dir" && GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 "$work/bin/go-licenses" report ./... --ignore "$OWN_MODULE" 2>"$stderr_log"); then
    cat "$stderr_log" >&2
    echo "ERROR: go-licenses failed in $module_dir for $target" >&2
    exit 2
  fi
  if [ -z "$target_report" ]; then
    # Nothing reported means nothing was checked: never a pass.
    cat "$stderr_log" >&2
    echo "ERROR: go-licenses reported no modules in $module_dir for $target" >&2
    exit 2
  fi
  if ! target_packages=$(cd "$module_dir" && GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go list -deps -f "$list_format" ./... 2>"$stderr_log"); then
    cat "$stderr_log" >&2
    echo "ERROR: go list failed in $module_dir for $target" >&2
    exit 2
  fi
  report+="$target_report"$'\n'
  packages+="$target_packages"$'\n'
done

# module_of <library>: the module@version of a library go-licenses reports.
# Its name is its packages' common import path, so a package at it or under
# it says which module (and version) it is.
module_of() {
  awk -v library="$1" '
    $1 == library || index($1, library "/") == 1 { print $2; exit }
  ' <<<"$packages"
}

# Each report line is "module,license URL,license". A module with several
# license files gets a line for each, and every one must be allowed.
disallowed=0
echo "Go module licenses (${module_dir}; ${TARGETS// /, }):"
while IFS=, read -r library _url license; do
  if grep -qxF -- "$license" <<<"$allowed"; then
    printf '  %-72s %s\n' "$library" "$license"
    continue
  fi
  version=$(module_of "$library")
  if [ "$license" = "$NAMED_LICENSE" ] && [ -n "$version" ] && grep -qxF -- "$version" <<<"$named"; then
    printf '  %-72s %s  (named in goModules: %s)\n' "$library" "$license" "$version"
    continue
  fi
  if [ "$license" = "$NAMED_LICENSE" ]; then
    printf '  %-72s %s  <- NOT ALLOWED (%s is not named in goModules)\n' "$library" "$license" "${version:-its module}"
  else
    printf '  %-72s %s  <- NOT ALLOWED\n' "$library" "$license"
  fi
  disallowed=$((disallowed + 1))
done < <(grep -v '^$' <<<"$report" | sort -u)

if [ "$disallowed" -gt 0 ]; then
  echo ""
  echo "ERROR: $disallowed module license(s) above are not on the allowed list in $policy."
  echo "Only a license that allows redistribution may be added to that list (ADR 0019)."
  exit 1
fi
echo "All Go module licenses are allowed."
