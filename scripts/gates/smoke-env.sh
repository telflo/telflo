# shellcheck shell=bash
# smoke-env.sh: source it (`. scripts/gates/smoke-env.sh oss|saas <work>`; bash
# or zsh) for the stack smoke (scripts/smoke-test-stack.sh) against a
# throwaway stack scripts/gates/stack.sh started with that --work. stack.sh
# sources it too, for every compose call, so the stack and the smoke read one
# set of values.
#
# It reads <work>/stack.conf (stack.sh's) and exports:
#   - the site's values: `saas` the SaaS's (registration open, the
#     playground, anonymous validate, the published flows, Terms 2026-01-01
#     with its two pages, the sales inquiries to sales@example.com, email
#     notifications on); `oss` the open-source defaults, as
#     docker-compose.yml's own defaults (invite-only, every switch off, no
#     Terms), set explicitly so stack.sh's ready check compares them;
#     TELFLO_SMOKE_SITE; STACK_SITE_VARIABLES, their names;
#   - COMPOSE_PROJECT_NAME and COMPOSE_FILE (the smoke's own `docker compose`
#     calls take the project from them; its throwaway-only steps run only
#     when the project is set and names a throwaway stack);
#   - the smoke's URLs, at stack.sh's ports (127.0.0.1, from the port base):
#     +1 db, +2 Mailpit SMTP, +3 Mailpit HTTP, +4 opamp management,
#     +5 opamp agent, +6 validator, +7 tester's forwarder, +8 evaluator's
#     forwarder, +9 gateway (TELFLO_GATEWAY_URL, equal to the stack's
#     TELFLO_PUBLIC_WEB_URL), +10 the smoke's replica, +11 object store;
#   - the file store the stack runs (TELFLO_SMOKE_FILE_STORE; on s3 also
#     TELFLO_FILE_STORE=s3 and COMPOSE_PROFILES=s3, which the smoke's calls
#     to the object store need);
#   - OPAMP_SERVER_URL, TELFLO_PUBLIC_API_URL, OTELCOL_VERSIONS=default (as
#     docs/conventions/testing.md's "The whole stack in containers"), no
#     Google settings;
#   - TMPDIR=<work>/smoke-tmp (the smoke's install steps mount a folder
#     under it).
# Never bring a stack up with a plain `docker compose up` after sourcing it:
# only through stack.sh (its checks: the project, the images, the PIN's
# image).
if [ "$#" -ne 2 ] || { [ "$1" != "oss" ] && [ "$1" != "saas" ]; }; then
  echo "usage: . smoke-env.sh oss|saas <work>" >&2
  return 2 2>/dev/null || exit 2
fi
_se_conf="$2/stack.conf"
if [ ! -f "$_se_conf" ]; then
  echo "smoke-env.sh: no $_se_conf: start the stack with scripts/gates/stack.sh up --work $2 first" >&2
  unset _se_conf
  return 1 2>/dev/null || exit 1
fi
_se_project=$(sed -n 's/^PROJECT=//p' "$_se_conf" | head -n 1)
_se_base=$(sed -n 's/^PORT_BASE=//p' "$_se_conf" | head -n 1)
_se_site=$(sed -n 's/^SITE=//p' "$_se_conf" | head -n 1)
_se_store=$(sed -n 's/^FILE_STORE=//p' "$_se_conf" | head -n 1)
_se_files=$(sed -n 's/^COMPOSE_FILE=//p' "$_se_conf" | head -n 1)
_se_bad=""
case "$_se_project" in
  ""|telflo|telflo-dev|telflo-platform) _se_bad="the project '$_se_project' is never a throwaway stack" ;;
esac
case "$_se_base" in ""|*[!0-9]*) _se_bad="${_se_bad:+$_se_bad; }no port base" ;; esac
[ "$_se_site" = "$1" ] || _se_bad="${_se_bad:+$_se_bad; }the stack runs the site '$_se_site', not '$1'"
case "$_se_store" in local|s3) ;; *) _se_bad="${_se_bad:+$_se_bad; }no file store" ;; esac
case "$2" in
  /*) ;;
  *) _se_bad="${_se_bad:+$_se_bad; }<work> must be an absolute path" ;;
esac
case "$2" in
  *[!A-Za-z0-9._/-]*) _se_bad="${_se_bad:+$_se_bad; }<work> must be letters, digits, '.', '_', '-' and '/' only" ;;
esac
if [ -n "$_se_bad" ]; then
  echo "smoke-env.sh: refused: $_se_bad" >&2
  unset _se_conf _se_project _se_base _se_site _se_store _se_files _se_bad
  return 2 2>/dev/null || exit 2
fi

# The site's values. docker-compose.yml interpolates each into api
# (the x-telflo-api-environment anchor) and web, all but
# TELFLO_SALES_INQUIRY_TO, the API's only (stack.sh checks the copy).
export TELFLO_SMOKE_SITE="$1"
export STACK_SITE_VARIABLES="TELFLO_REGISTRATION TELFLO_PLAYGROUND TELFLO_ANONYMOUS_VALIDATE TELFLO_PUBLIC_FLOWS TELFLO_TERMS_VERSION TELFLO_TERMS_URL TELFLO_PRIVACY_URL TELFLO_SALES_INQUIRY TELFLO_SALES_INQUIRY_TO TELFLO_EMAIL_NOTIFICATIONS TELFLO_USER_FEEDBACK TELFLO_LEARNING TELFLO_USER_ADMIN"
if [ "$1" = "saas" ]; then
  export TELFLO_REGISTRATION=open
  export TELFLO_PLAYGROUND=true
  export TELFLO_ANONYMOUS_VALIDATE=true
  export TELFLO_PUBLIC_FLOWS=true
  export TELFLO_TERMS_VERSION=2026-01-01
  export TELFLO_TERMS_URL=/home/terms-of-service
  export TELFLO_PRIVACY_URL=/home/privacy-policy
  export TELFLO_SALES_INQUIRY=true
  export TELFLO_SALES_INQUIRY_TO=sales@example.com
  export TELFLO_EMAIL_NOTIFICATIONS=true
  export TELFLO_USER_FEEDBACK=true
  export TELFLO_LEARNING=true
  export TELFLO_USER_ADMIN=true
else
  export TELFLO_REGISTRATION=invite-only
  export TELFLO_PLAYGROUND=false
  export TELFLO_ANONYMOUS_VALIDATE=false
  export TELFLO_PUBLIC_FLOWS=false
  export TELFLO_TERMS_VERSION=
  export TELFLO_TERMS_URL=
  export TELFLO_PRIVACY_URL=
  export TELFLO_SALES_INQUIRY=false
  export TELFLO_SALES_INQUIRY_TO=
  export TELFLO_EMAIL_NOTIFICATIONS=false
  export TELFLO_USER_FEEDBACK=false
  export TELFLO_LEARNING=false
  export TELFLO_USER_ADMIN=false
fi

export COMPOSE_PROJECT_NAME="$_se_project"
export COMPOSE_FILE="$_se_files"

export TELFLO_GATEWAY_URL="http://localhost:$((_se_base + 9))"
export TELFLO_MAILPIT_API_URL="http://localhost:$((_se_base + 3))"
export TELFLO_OPAMP_MANAGEMENT_HOST_URL="http://127.0.0.1:$((_se_base + 4))"
export TELFLO_OTELCOL_VALIDATOR_HOST_URL="http://127.0.0.1:$((_se_base + 6))"
export TELFLO_OTELCOL_TESTING_HOST_URL="http://127.0.0.1:$((_se_base + 7))"
export TELFLO_OTTL_EVALUATOR_HOST_URL="http://127.0.0.1:$((_se_base + 8))"
export TELFLO_OPAMP_AGENT_HOST_URL="http://127.0.0.1:$((_se_base + 5))"
export TELFLO_OPAMP_REPLICA_HOST_PORT="$((_se_base + 10))"

export TELFLO_SMOKE_FILE_STORE="$_se_store"
if [ "$_se_store" = "s3" ]; then
  export TELFLO_FILE_STORE=s3 COMPOSE_PROFILES=s3
else
  unset TELFLO_FILE_STORE COMPOSE_PROFILES
fi

export OPAMP_SERVER_URL=http://opamp-server:51234/opamp/api/v1
export TELFLO_PUBLIC_API_URL=http://gateway
export OTELCOL_VERSIONS=default
unset TELFLO_OIDC_GOOGLE_CLIENT_ID TELFLO_OIDC_GOOGLE_CLIENT_SECRET TELFLO_OIDC_GOOGLE_ISSUER

mkdir -p "$2/smoke-tmp"
export TMPDIR="$2/smoke-tmp"

echo "smoke env: project $COMPOSE_PROJECT_NAME, gateway $TELFLO_GATEWAY_URL, file store $TELFLO_SMOKE_FILE_STORE, profiles ${COMPOSE_PROFILES:-(none)}, site $TELFLO_SMOKE_SITE (registration $TELFLO_REGISTRATION)"
unset _se_conf _se_project _se_base _se_site _se_store _se_files _se_bad
