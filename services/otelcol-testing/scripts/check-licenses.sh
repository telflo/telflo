#!/usr/bin/env bash
# Fails if any Python package the tester ships carries a license that does
# not allow redistribution. telflo ships the tester's image too, so its
# Python dependencies follow the same rule as the npm and Go ones.
# Only licenses on the policy's allowed list pass. A copy of the
# validator's check (services/otelcol-validator/scripts/check-licenses.sh),
# changed only in its comments.
#
# Usage: scripts/check-licenses.sh [license-policy.json] [lock]
#
#   license-policy.json  the allowed list; defaults to the platform's
#                        scripts/license-policy.json, two levels above this
#                        service. An argument, as the opamp-server's was, so
#                        the service can carry its own copy if it moves, as
#                        the opamp-server's does in its own repository.
#   lock                 the hash-pinned lock whose packages ship; defaults
#                        to this service's runtime lock, requirements.txt.
#                        The self-test points it at its fixtures.
#
# Needs a Python 3.12 with the development lock installed (pip-licenses comes
# from it): python3, or $PYTHON. It makes a throwaway virtual environment,
# installs ONLY the lock into it (--require-hashes, wheels, no dependency
# outside the lock: what the image installs), and runs pip-licenses against
# that environment, so the development tools' own licenses never count: they
# never ship. evaluate-licenses.py maps each package's license to SPDX (its
# PEP 639 expression, else its License field, else its trove classifiers)
# and compares it with the policy's "allowed" list; an unknown license fails,
# since it can't be shown to be redistributable. The policy's "exceptions"
# name npm packages and are not read here.
#
# The image's base (python:3.12-slim), tini, the collectors and kwok's
# binaries it bakes are not Python packages and aren't scanned here: they are
# reviewed components, pinned by digest and sha256.
#
# Exits 0 when every license is allowed, 1 when one isn't, 2 when the check
# itself can't run.
set -euo pipefail

service_dir=$(cd "$(dirname "$0")/.." && pwd)
policy=${1:-$service_dir/../../scripts/license-policy.json}
lock=${2:-$service_dir/requirements.txt}
python=${PYTHON:-python3}

if [ ! -f "$policy" ]; then
  echo "ERROR: no license policy at $policy" >&2
  exit 2
fi
if [ ! -f "$lock" ]; then
  echo "ERROR: no lock at $lock" >&2
  exit 2
fi
if ! "$python" -m piplicenses --version >/dev/null 2>&1; then
  echo "ERROR: $python has no pip-licenses: install requirements-dev.txt first" >&2
  exit 2
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# pip and the installer's output stay out of the way unless they fail.
if ! "$python" -m venv "$scratch/venv" >"$scratch/venv.log" 2>&1; then
  cat "$scratch/venv.log" >&2
  echo "ERROR: couldn't make a virtual environment with $python" >&2
  exit 2
fi
if ! "$scratch/venv/bin/python" -m pip install --quiet --disable-pip-version-check \
     --require-hashes --no-deps --only-binary=:all: -r "$lock" >"$scratch/pip.log" 2>&1; then
  cat "$scratch/pip.log" >&2
  echo "ERROR: couldn't install $lock" >&2
  exit 2
fi

# --with-system: pip-licenses otherwise hides pip, setuptools, wheel and its
# own dependencies (prettytable, wcwidth), which a lock may well ship. The
# environment's own pip (from venv, not the lock) is then left out by name,
# unless the lock pins it.
if ! "$python" -m piplicenses --python "$scratch/venv/bin/python" --from=all --format=json \
     --with-system >"$scratch/report.json" 2>"$scratch/piplicenses.log"; then
  cat "$scratch/piplicenses.log" >&2
  echo "ERROR: pip-licenses failed" >&2
  exit 2
fi
if ! grep -qiE '^pip(==| @)' "$lock"; then
  "$python" - "$scratch/report.json" <<'PY'
import json, sys
path = sys.argv[1]
report = [package for package in json.load(open(path)) if package["Name"].lower() != "pip"]
json.dump(report, open(path, "w"))
PY
fi

# Not exec: the trap removes the environment once the evaluation is done.
status=0
"$python" "$service_dir/scripts/evaluate-licenses.py" "$policy" "$scratch/report.json" "$lock" || status=$?
exit "$status"
