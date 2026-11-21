#!/usr/bin/env bash
# redact.sh: the gates' redaction filter (docs/conventions/security.md's
# redaction rules). Standard input to standard output, every line with these
# replaced by a `[REDACTED]` marker:
#   - tf_, tqd_ and tll_ tokens (classes widened by base64's + / and =);
#   - the value of any …SECRET_ACCESS_KEY=, …SIGNING_KEY= or
#     …SIGNING_KEYS_PREVIOUS= setting;
#   - anything after PASSWORD=, SECRET= or KEY= (any variable ending so);
#   - the development object store's secret (docker-compose.yml's), which a
#     stack's own logs may print bare;
#   - with `--literals <file>`: each non-empty line of that file, as a fixed
#     string (a run's generated secrets, the caller's test keys). The file
#     is read, never printed.
# Count the hits afterwards with `grep -c REDACTED <log>`: a hit is
# token-shaped text that reached the output (look at what printed it, never
# at the raw text).
#
# Usage: <command> 2>&1 | bash scripts/gates/redact.sh [--literals <file>]
# bash 3.2 compatible.
set -u

literals=""
case "${1:-}" in
  "") ;;
  --literals)
    [ "$#" -eq 2 ] || { echo "usage: redact.sh [--literals <file>]" >&2; exit 2; }
    literals=$2
    [ -f "$literals" ] && [ -r "$literals" ] || { echo "redact.sh: --literals names no readable file" >&2; exit 2; }
    ;;
  *) echo "usage: redact.sh [--literals <file>]" >&2; exit 2 ;;
esac

fixed_rules() {
  sed -E \
    -e 's#tf_[A-Za-z0-9_+/=-]+#tf_[REDACTED]#g' \
    -e 's#tqd_[A-Za-z0-9_+/=-]+#tqd_[REDACTED]#g' \
    -e 's#tll_[A-Za-z0-9_+/=-]+#tll_[REDACTED]#g' \
    -e 's#(SECRET_ACCESS_KEY|SIGNING_KEY|SIGNING_KEYS_PREVIOUS)=[^[:space:]]+#\1=[REDACTED]#g' \
    -e 's#telflo-development-only-object-store-secret-not-for-production#[REDACTED-object-store-secret]#g' \
    -e 's#(PASSWORD|SECRET|KEY)=[^[:space:]]+#\1=[REDACTED]#g'
}

if [ -z "$literals" ]; then
  fixed_rules
  exit 0
fi

# The literals first (a sed program built from the file in a private
# temporary file, each value escaped for a basic regular expression and the
# `#` delimiter, so no value is ever on an argv), then the fixed rules.
umask 077
program=$(mktemp "${TMPDIR:-/tmp}/redact.XXXXXX") || exit 2
trap 'rm -f "$program"' EXIT
while IFS= read -r value || [ -n "$value" ]; do
  [ -n "$value" ] || continue
  escaped=$(printf '%s\n' "$value" | sed -e 's/[]\$*.^[#]/\\&/g')
  printf 's#%s#[REDACTED-literal]#g\n' "$escaped"
done <"$literals" >"$program"
sed -f "$program" | fixed_rules
