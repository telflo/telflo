#!/usr/bin/env bash
# Checks that the gateway's logs never hold a quick-deploy link's secret, nor
# an API token, nor a library link (sections 3 and 4). Runs the real image,
# nginx:1.30-alpine (never pulled: it must already be on the machine), with the
# real docker/gateway/default.conf, unchanged, its upstreams' names resolving
# to the container's own loopback (--add-host), where two stand-in servers
# answer for the API and the web app. Its include of
# /etc/nginx/telflo/extra-routes.conf reads, in sections 1-10, the compose
# stack's docker/gateway/extra-routes.conf (comments only, no route), and in
# section 11 the chart's rendered fixture. It sends a canary secret in every
# spelling that reaches the route, and asserts:
#
#   1. upstreams up: no access or error log line holds the canary; each such
#      request's access log line is the redacted one; each went where it goes
#      in the stack: the API's path to the API, the same typed without /api/
#      answered by nginx itself, a plain 404 "Not found." as Content-Type:
#      text/plain whatever the path's extension, the web stand-in receiving
#      none of them (it counts its requests), and a web path holding tqd_ (an
#      asset's name, a secret in another segment) to the web app; a secret in
#      another path's query, any letter of its tqd_ prefix percent-encoded or
#      not, is cut from the access log too; a Referer naming a link, in any of
#      those spellings, is logged as [redacted]; an ordinary request is logged
#      as before, query, referer and all, and an ordinary web path reaches the
#      web stand-in; and a request line or a Referer holding an API token's
#      tf_, any letter percent-encoded once or not, case aside, is logged
#      redacted ("GET /[redacted] HTTP/1.1"; "[redacted]"), still routed where
#      it goes, with no access or error log line holding the token; and a token
#      sent as an HTTP Basic user name (`curl -u "$TF:"`) is in no field: the
#      user field is "-" (no field of the access log is derived from the
#      Authorization header); and a User-Agent or an X-Forwarded-For holding
#      tf_, in the same spellings, is logged "[redacted]" (no logged field
#      holding a client-supplied value carries a tf_ token), an ordinary one as
#      before;
#   2. upstreams down (no stand-ins, so nginx can't connect): the same, the
#      upstreams' requests answered 502 and the paths typed without /api/
#      still nginx's plain-text 404, and an ordinary API request's failure IS in the
#      error log (so the check isn't passing on an error log that writes
#      nothing).
#   3. a library link (tll_), upstreams up, on a fresh container: the same,
#      by the link's own rules: its API paths (an organization's and a
#      library file's paths holding one too) to the API, the same typed
#      without /api/ nginx's plain-text 404 (/library-links/tqd_x.js among
#      them: the locations' order), the web stand-in receiving none; a web
#      path holding tll_ to the web app; each logged "GET
#      /api/v1/library-links/[redacted] HTTP/1.1" (the one 404 whose path
#      also holds tqd_, the quick-deploy line); a link in another path's
#      query, any letter of tll_ percent-encoded or not, cut too; a Referer,
#      a User-Agent or an X-Forwarded-For holding one "[redacted]"; the
#      library's ordinary paths logged as before;
#   4. the same link, upstreams down: 502 and the plain 404 as above, no
#      access or error log line holding it (an organization's path holding
#      one included), and an ordinary failure in the error log.
#   5. the public surface, upstreams up, on a fresh container: every
#      request under /api/public/v1, in any spelling (case, encoded and
#      doubly encoded letters and slashes, runs of slashes, dot segments,
#      an absolute-form request line), is logged "METHOD
#      /api/public/v1/[redacted] PROTOCOL", its path and query never: no
#      access or error log line holds a tf_ canary (seven cases) or a
#      validation pipeline's name in route 14's path (a marker), each
#      request still reaching the upstream it reaches today; the public
#      body limits: 2 MiB on the configuration writes, /validate and
#      /ottl/lint, 8 MiB on /test-runs (a body under each passes, one a
#      little over is nginx's 413), 1 MiB on the other public paths; route
#      14's PUT over 1 MiB and a 2 MiB location's body over 2 MiB, their
#      query naming the pipeline, nginx's 413 with the name in no log line;
#      an ordinary path is logged as before.
#   6. the same public spellings, upstreams down: 502 (route 14's oversized
#      PUT 413), no access or error log line holding a tf_ canary or the
#      pipeline's name (every public location logs crit and worse only), an
#      ordinary API path's failure still in the error log.
#   7. product administration, upstreams up, on a fresh container: every
#      request under /api/v1/product-admin, in any spelling nginx routes there
#      (runs of slashes, dot segments, an encoded letter), its query holding a
#      search term (a made-up address, raw and percent-encoded), is logged "GET
#      <its path as nginx routes it> HTTP/1.1", never its query: no access or
#      error log line holds the term; each reaches the API; another case (which
#      the API doesn't route) is logged without its query too; a tf_ in such a
#      path is the tf_ line; an ordinary path is logged as before.
#   8. the same, upstreams down: 502, no access or error log line holding
#      the term (the product-admin location logs crit and worse only), an
#      ordinary API path's failure still in the error log.
#   9. an organization's fleets, its configurations list and the open flow
#      read, upstreams up, on a fresh container: a request under
#      /api/v1/organizations/<id>/fleets or for the configurations list (a
#      trailing slash or not), in any spelling nginx routes there (runs of
#      slashes, dot segments, an encoded letter), its query holding a
#      marker, is logged "GET <its path as nginx routes it> HTTP/1.1"; one
#      under /api/v1/published-flows, the slug or the query holding a marker
#      (slashes, dot segments, encoded letters, an encoded or doubly encoded
#      slash, a ";", a "?" or a "#" decoded from the path), "GET
#      /api/v1/published-flows HTTP/1.1" (the list) or "GET
#      /api/v1/published-flows/:slug HTTP/1.1": every request's line
#      exactly, no access or error log line holding a marker, each reaching
#      its upstream; another case is logged so too (to the web app, as the
#      API's locations match case); the lookalikes
#      (/api/v1/published-flowsx/..., .../fleetsx) and a configuration's own
#      paths (.../configurations/c1/versions?limit=5: the "query kept"
#      canary) logged as sent; a tf_ or a quick-deploy secret in such a path
#      their own lines; the configurations list's 5 MiB, a trailing slash or
#      not.
#  10. the same, upstreams down: 502, no access or error log line holding a
#      marker (the fleets, published-flows and configurations list
#      locations log crit and worse only; the list's create over 5 MiB,
#      413, too), every line exactly; the lookalike's and an ordinary API
#      path's failures still in the error log.
#  11. gateway.extraRoutes, on a fresh container whose include reads the
#      chart's rendered snippet
#      (charts/telflo/tests/expected/extra-routes.conf, an exact / and a ^~
#      /home/ prefix to website.telflo.svc:8081; a render case holds helm's
#      output equal to it): nginx -t accepts it; / and every path under /home/,
#      in any spelling nginx routes there (runs of slashes, an encoded letter,
#      dot segments), reach a third stand-in for the site; /home is nginx's 301
#      to /home/; /homex, /HOME/x and the web app's paths (/login, /_root.data,
#      /forgot-password, /robots.txt, /assets/...) still reach the web app and
#      /api/ the API; the access log's rules hold there (a tf_ token, a
#      quick-deploy secret typed under /home/: redacted); upstreams down, the
#      site's paths 502 with no access or error log line holding their marker
#      (each block logs crit and worse only), an ordinary API path's failure
#      still in the error log; and without the snippet nginx doesn't start
#      ([emerg]).
#
# Sections 1-4's lines for a path under /api/public/v1 (a tf_ in its path
# or query, or a Referer, User-Agent, X-Forwarded-For or Basic user name
# holding one) are that fixed public line too.
#
# Residues (not checked): the locations that log crit and worse only are
# the quick-deploy and library-link ones (and their 404s typed without
# /api/, and the web paths holding tqd_ or tll_), the public surface's (any
# spelling of /api/public/v1 above; sections 5 and 6, whose down run sends
# the public spellings with tf_ canaries) and product administration's
# (sections 7 and 8), the fleets', the published flows' and the
# configurations list's (sections 9 and 10) and each extra route's (section
# 11). A product-admin, fleets, configurations-list or published-flows path
# in another case (/API/V1/PRODUCT-ADMIN/...) matches no API location
# (case-sensitive, as the API's router): it goes to the web app as any
# other such path, its access log line without its query (or its slug), but
# its error log at the image's level with the web app down, so sections 8
# and 10 don't send one. An extra route's prefix wins over the quick-deploy
# and library-link locations for a path under it
# (/home/quick-deploy/tqd_...: proxied to the site, not nginx's 404; its
# access log line still redacted), and website's own logs are its own.
# Every other location's error log quotes a request line, its referrer and
# its host when its upstream fails: a secret pasted into ANOTHER path's
# query, a Referer naming one on a request for another path, or a tf_ token
# in the Host header (its line's host: "…") is cut from the access log but
# kept there, so those cases run with the upstreams up only. An /api/v1
# size location can be made to climb into the public prefix by a request
# crafted with a doubly encoded parameter, and logs at the image's level:
# caller-made text only, never a route 14 pipeline's name, the API still
# answering the one 401. A tqd_ secret in a User-Agent or an
# X-Forwarded-For is logged as sent (their rules cover tf_ and tll_ only).
# And a web path or query holding tqd_, tll_ or tf_ reaches the web app,
# whose own server writes no request's URL or path.
#
# Its files (the stand-ins' config, the logs it reads) go in a directory
# under $TMPDIR (/tmp when unset); it prints where, and removes it at the
# end. The template is spelt out because macOS's mktemp -d, without one,
# ignores TMPDIR.
#
# Usage: scripts/check-gateway-logs.sh
#   CHECK_GATEWAY_LOGS_CONTAINER (default telflo-check-gateway-logs) and
#   CHECK_GATEWAY_LOGS_PORT (default 50089, published on 127.0.0.1 only)
#   name the container, removed by name at the end, and its port.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=nginx:1.30-alpine
CONTAINER=${CHECK_GATEWAY_LOGS_CONTAINER:-telflo-check-gateway-logs}
PORT=${CHECK_GATEWAY_LOGS_PORT:-50089}
CONFIG=docker/gateway/default.conf
# The include's file: the compose stack's (no route), and the chart's
# rendered snippet for section 11.
EXTRA_ROUTES=docker/gateway/extra-routes.conf
EXTRA_ROUTES_FIXTURE=charts/telflo/tests/expected/extra-routes.conf
# The fixture's service, as the chart names it in the render tests' namespace.
SITE_HOST=website.telflo.svc
FAILURES=0

SECRET=tqd_CANARYCANARYCANARYCANARYCANARYCANARYCANARY0
BODY=${SECRET#tqd_}
# What no log line may hold: the secret's random part, in any spelling.
CANARY=CANARYCANARY
# An API token's canary: built here, at run time, never a literal token in
# this file: tf_ and 43 characters. Nothing prints it: the messages below
# name its cases by number.
TF_BODY="$(printf 'TFCANARY%.0s' 1 2 3 4 5)TFC"
TF="tf_$TF_BODY"
TF_CANARY=TFCANARYTFCANARY
# A library link's canary: built here, at run time, never a literal link in
# this file: tll_ and 71 characters, as a link's shape. Nothing prints it: the
# messages below show it as "…".
LL_BODY="$(printf 'LLCANARY%.0s' 1 2 3 4 5 6 7 8)LLCANAR"
LINK="tll_$LL_BODY"
LL_CANARY=LLCANARYLLCANARY

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: $IMAGE isn't on this machine (this check never pulls it)"
  exit 1
fi

tmp_root=${TMPDIR:-/tmp}
work=$(mktemp -d "${tmp_root%/}/check-gateway-logs.XXXXXX") || {
  echo "FAIL: couldn't make a directory for the check's files"
  exit 1
}
echo "writing the check's files under $work"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Stand-ins for the API (telflo-api:8080) and the web app (telflo-web:3000).
# The web stand-in counts its requests: one line each in a file of its own
# (WEB_COUNT, never the container's stdout), holding no URL. Neither limits
# a body (client_max_body_size 0): section 5's sizes are the gateway's.
WEB_COUNT=/var/log/nginx/web-stand-in.count
cat >"$work/standins.conf" <<CONF
log_format telflo_stand_in 'web';
server { listen 127.0.0.1:8080; access_log off; client_max_body_size 0; location / { return 200 "api stand-in"; } }
server { listen 127.0.0.1:3000; access_log $WEB_COUNT telflo_stand_in; client_max_body_size 0; location / { return 200 "web stand-in"; } }
CONF
# Section 11's stand-in for an extra route's service (the fixture's
# $SITE_HOST:8081): its reply names it.
cat >"$work/site-standin.conf" <<CONF
server { listen 127.0.0.1:8081; access_log off; location / { return 200 "site stand-in"; } }
CONF
# The include's folder (/etc/nginx/telflo): the compose stack's file, or
# section 11's fixture.
mkdir "$work/telflo" "$work/telflo-fixture" &&
  cp "$EXTRA_ROUTES" "$work/telflo/extra-routes.conf" &&
  cp "$EXTRA_ROUTES_FIXTURE" "$work/telflo-fixture/extra-routes.conf" || {
  echo "FAIL: couldn't copy $EXTRA_ROUTES and $EXTRA_ROUTES_FIXTURE"
  exit 1
}

# Creates the container with the real config and the include's folder $2
# (the compose stack's when not given; "none" for none), and the stand-ins
# when $1 is "up" (the site's too with the fixture), without starting it.
create_gateway() {
  local folder=${2:-$work/telflo}
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker create --pull never --name "$CONTAINER" -p "127.0.0.1:$PORT:80" \
    --add-host telflo-api:127.0.0.1 --add-host telflo-web:127.0.0.1 --add-host "$SITE_HOST:127.0.0.1" "$IMAGE" >/dev/null || {
    echo "FAIL: couldn't create $CONTAINER"
    exit 1
  }
  docker cp "$CONFIG" "$CONTAINER:/etc/nginx/conf.d/default.conf" >/dev/null || exit 1
  if [ "$folder" != none ]; then docker cp "$folder" "$CONTAINER:/etc/nginx/telflo" >/dev/null || exit 1; fi
  if [ "$1" = up ]; then docker cp "$work/standins.conf" "$CONTAINER:/etc/nginx/conf.d/standins.conf" >/dev/null || exit 1; fi
  if [ "$1" = up ] && [ "$folder" = "$work/telflo-fixture" ]; then
    docker cp "$work/site-standin.conf" "$CONTAINER:/etc/nginx/conf.d/site-standin.conf" >/dev/null || exit 1
  fi
}

# Starts the container with the real config (create_gateway's arguments).
start_gateway() {
  create_gateway "$@"
  docker start "$CONTAINER" >/dev/null || {
    echo "FAIL: $CONTAINER didn't start"
    docker logs "$CONTAINER"
    exit 1
  }
  local attempt
  for attempt in $(seq 1 100); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    [ "$attempt" = 100 ] && { echo "FAIL: nginx didn't answer"; docker logs "$CONTAINER"; exit 1; }
    sleep 0.1
  done
  if docker exec "$CONTAINER" nginx -t >"$work/nginx-t" 2>&1; then
    echo "ok: nginx -t accepts $CONFIG ($1${2:+, $(basename "$2")})"
  else
    fail "nginx -t refused $CONFIG ($1${2:+, $(basename "$2")})"
    cat "$work/nginx-t"
  fi
}

# Sends GET $1 as spelt (curl resolves no dot segment with --path-as-is),
# with the Referer $2 if there is one; sets $status, $content_type (the
# reply's Content-Type, empty when it has none) and $body.
send() {
  local referer=()
  [ $# -ge 2 ] && referer=(-H "Referer: $2")
  # (Bash 3.2's set -u calls an empty array unbound: hence the +.)
  body=$(curl -s --path-as-is ${referer[@]+"${referer[@]}"} -w '\n%{content_type}\n%{http_code}' "http://127.0.0.1:$PORT$1")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  content_type=${body##*$'\n'}
  body=${body%$'\n'*}
}

# The number of requests the web stand-in has answered.
web_requests() {
  docker exec "$CONTAINER" sh -c "wc -l < $WEB_COUNT" | tr -d ' '
}

# $1 for a message, the canary's random part cut (a path holding it is never printed whole).
shown() {
  printf '%s' "${1//$BODY/…}"
}

# $1's first line, shown.
first_line() {
  local nl=$'\n'
  shown "${1%%"$nl"*}"
}

# Waits until the access log holds at least $1 lines; then $access and $errors hold the two logs.
read_logs() {
  local attempt
  for attempt in $(seq 1 100); do
    docker logs "$CONTAINER" >"$work/stdout" 2>"$work/stderr"
    access=$(grep -E '^[0-9.]+ - ' "$work/stdout")
    errors=$(cat "$work/stderr")
    [ "$(printf '%s\n' "$access" | grep -c .)" -ge "$1" ] && return
    sleep 0.1
  done
  fail "the access log never held $1 lines"
}

# The paths that hold a secret and reach the API's location: as spelt,
# with a query, doubled slashes, an encoded slash, upper case, dot
# segments, encoded letters, an encoded prefix, a trailing slash.
API_SPELLINGS=(
  "/api/v1/quick-deploy/$SECRET"
  "/api/v1/quick-deploy/$SECRET?x=1"
  "//api/v1/quick-deploy/$SECRET"
  "/api/v1//quick-deploy/$SECRET"
  "/api/v1/quick-deploy%2F$SECRET"
  "/API/V1/QUICK-DEPLOY/$SECRET"
  "/api/v1/x/../quick-deploy/$SECRET"
  "/api/v1/./quick-deploy/$SECRET"
  "/api/v1/%71uick-deploy/%74qd_$BODY"
  "/api/v1/quick-deploy/tqd%5F$BODY"
  "/api/v1/quick-deploy/$SECRET/"
  "/api/v1/quick-deploy/$SECRET/../x"
)
# The same typed without /api/: nginx's own 404, never proxied. As spelt,
# with a query, upper case, runs of slashes, an encoded letter (lower and
# upper case codes), an encoded slash before and after, dot segments, under
# another path, the path ending in /quick-deploy; and two whose extensions
# nginx's types would name otherwise (text/html, application/javascript),
# still plain text.
NGINX_404_SPELLINGS=(
  "/quick-deploy/$SECRET"
  "/QUICK-DEPLOY/$SECRET?x=1"
  "//quick-deploy/$SECRET"
  "///quick-deploy//$SECRET"
  "/%71uick-deploy/$SECRET"
  "/%51UICK-DEPLOY/%74qd_$BODY"
  "/quick-deploy%2F$SECRET"
  "/x%2Fquick-deploy/$SECRET"
  "/x/../quick-deploy/$SECRET"
  "/./quick-deploy/$SECRET"
  "/app/quick-deploy/$SECRET"
  "/quick-deploy?s=$SECRET"
  "/quick-deploy/x.html"
  "/quick-deploy/tqd_x.js"
)
NOT_FOUND="404 Not found."
NOT_FOUND_TYPE=text/plain
# A web path holding tqd_ elsewhere: the web app's, as before (an asset's
# name may hold it; see the residue above).
WEB_TQD_PATHS=(
  "/assets/tqd_chunk.js"
  "/x/$SECRET"
)
# A secret in another path's query: cut from the access log (upstreams up
# only; see the residue above). As spelt, and each character of its prefix
# percent-encoded, the letters' upper-case codes too.
QUERY_SPELLINGS=(
  "/api/v1/auth/me?s=$SECRET"
  "/register?s=tqd%5F$BODY"
  "/api/v1/auth/me?s=%74qd_$BODY"
  "/api/v1/auth/me?s=t%71d_$BODY"
  "/register?s=tq%64_$BODY"
  "/register?s=%54%51%44%5f$BODY"
)
# A Referer naming a link, on a request for another path (a web asset the
# web app's 404 page loads, or an API call): logged as [redacted] (upstreams
# up only; see the residue above). The link as the browser sends it, typed
# without /api/, its prefix's letters encoded, in another page's query, and
# without its prefix behind an encoded slash.
REFERERS=(
  "https://telflo.example/api/v1/quick-deploy/$SECRET"
  "https://telflo.example/quick-deploy/$SECRET"
  "https://telflo.example/x/%74qd_$BODY"
  "https://telflo.example/x/t%71d%5F$BODY"
  "https://telflo.example/forgot-password?s=%54QD_$BODY"
  "https://telflo.example/quick-deploy%2F$BODY"
)
REFERRED_PATHS=("/assets/app.js" "/api/v1/auth/me") # as the count below matches them
REDACTED='"GET /api/v1/quick-deploy/[redacted] HTTP/1.1"'
# An API token in a request line: in the public surface's path and query,
# in another API path's query, in a web path and query, the public prefix
# in upper case (the API's: the public location matches it case aside),
# each letter of tf_ percent-encoded (lower- and upper-case codes), and all
# three. Each reaches its upstream as before, logged "GET /[redacted]
# HTTP/1.1" (upstreams up only; see the residue).
# [the upstream's reply, the path].
TF_REQUESTS=(
  "api|/api/public/v1/whoami?token=$TF"
  "api|/api/public/v1/whoami/$TF"
  "api|/api/v1/auth/me?t=$TF"
  "api|/API/PUBLIC/V1/TF_$TF_BODY"
  "api|/api/v1/auth/me?t=%74f_$TF_BODY"
  "api|/api/v1/auth/me?t=t%66_$TF_BODY"
  "api|/api/v1/auth/me?t=tf%5F$TF_BODY"
  "api|/api/v1/auth/me?t=%54%46%5f$TF_BODY"
  "web|/register?t=%74%66%5F$TF_BODY"
  "web|/assets/x-$TF.js"
  "web|/x/Tf_$TF_BODY"
)
TF_REDACTED='"GET /[redacted] HTTP/1.1"'
# A public path's line: the public surface's own fixed line.
PUBLIC_REDACTED='"GET /api/public/v1/[redacted] HTTP/1.1"'
# A Referer holding an API token, on requests for paths of their own (not
# REFERRED_PATHS, whose count above is the quick-deploy Referers'): as
# spelt, upper case, each letter encoded, all three encoded.
TF_REFERERS=(
  "https://telflo.example/x?t=$TF"
  "https://telflo.example/X?T=TF_$TF_BODY"
  "https://telflo.example/x?t=%74f_$TF_BODY"
  "https://telflo.example/x?t=t%66_$TF_BODY"
  "https://telflo.example/x?t=tf%5f$TF_BODY"
  "https://telflo.example/x?t=%54%46%5F$TF_BODY"
)
TF_REFERRED_PATHS=("/assets/token-referred.js" "/api/public/v1/referred") # as the count below matches them
# An API token sent as an HTTP Basic user name, `curl -u "$TF:"`: nginx fills
# $remote_user from it, so the format's user field is a fixed "-" and the line
# holds neither the token nor its Basic encoding. To the public surface and to
# a web path, as HEAD requests (a public path's line reads like any other
# public request's: the method tells these apart).
TF_BASIC_PATHS=("/api/public/v1/basic-user" "/assets/basic-user.js") # as the count below matches them
# The Basic credentials' base64 ("$TF:"), a stretch from its middle: no line may hold it either.
TF_BASIC_ENCODED=$(printf '%s:' "$TF" | base64 | tr -d '\n')
TF_BASIC_CANARY=${TF_BASIC_ENCODED:8:24}
# A User-Agent and an X-Forwarded-For holding an API token, each on paths of
# its own (as the counts below match them): as spelt, after other text, upper
# case, each letter encoded, all three encoded.
TF_HEADER_VALUES=(
  "$TF"
  "x/1.0 TF_$TF_BODY"
  "%74f_$TF_BODY"
  "t%66_$TF_BODY"
  "tf%5f$TF_BODY"
  "%54%46%5F$TF_BODY"
)
TF_AGENT_PATHS=("/assets/token-agent.js" "/api/public/v1/agent")
TF_FORWARDED_PATHS=("/assets/token-forwarded.js" "/api/public/v1/forwarded")

check_no_canary() {
  if printf '%s\n%s\n' "$access" "$errors" | grep -q "$CANARY"; then
    fail "$1: a log line holds the secret"
    printf '%s\n%s\n' "$access" "$errors" | grep "$CANARY"
  else
    echo "ok: $1: no access or error log line holds the secret"
  fi
}

# ---------------------------------------------------------------------------
# 1. The upstreams up.
start_gateway up
sent=0
for path in "${API_SPELLINGS[@]}"; do
  send "$path"
  sent=$((sent + 1))
  [ "$status $body" = "200 api stand-in" ] || fail "$path reached '$status $body', not the API"
done
web_before=$(web_requests)
refused=0
for path in "${NGINX_404_SPELLINGS[@]}"; do
  send "$path"
  refused=$((refused + 1))
  [ "$status $body" = "$NOT_FOUND" ] || fail "$(shown "$path") typed without /api/ answered '$status $(first_line "$body")', not nginx's '$NOT_FOUND'"
  [ "$content_type" = "$NOT_FOUND_TYPE" ] || fail "$(shown "$path") typed without /api/ answered Content-Type '$content_type', not $NOT_FOUND_TYPE"
done
web_after=$(web_requests)
if [ -n "$web_before" ] && [ "$web_after" = "$web_before" ]; then
  echo "ok: upstreams up: each of the $refused paths typed without /api/ is nginx's '$NOT_FOUND' ($NOT_FOUND_TYPE), the web stand-in receiving none"
else
  fail "upstreams up: the web stand-in received $((web_after - web_before)) of the $refused paths typed without /api/ (counts '$web_before', '$web_after')"
fi
for path in "${WEB_TQD_PATHS[@]}" "/register?x=1"; do
  web_before=$(web_requests)
  send "$path"
  [ "$path" = "/register?x=1" ] || sent=$((sent + 1))
  web_after=$(web_requests)
  if [ "$status $body" = "200 web stand-in" ] && [ "$web_after" = "$((web_before + 1))" ]; then
    echo "ok: $(shown "$path") reaches the web stand-in"
  else
    fail "$(shown "$path") answered '$status $body', the web stand-in counting '$web_before' then '$web_after', not the web app's"
  fi
done
for path in "${QUERY_SPELLINGS[@]}"; do
  send "$path"
  sent=$((sent + 1))
done
referred=0
for referer in "${REFERERS[@]}"; do
  for path in "${REFERRED_PATHS[@]}"; do
    send "$path" "$referer"
    referred=$((referred + 1))
    [ "$status" = 200 ] || fail "$path with a link's Referer answered $status"
  done
done
send "/api/v1/auth/me?x=1" "https://telflo.example/app/fleets?tab=groups"
[ "$status $body" = "200 api stand-in" ] || fail "/api/v1/auth/me?x=1 reached '$status $body'"
send "/api/v1/organizations/o1/fleets/f1/quick-deploy-links?limit=5" "https://telflo.example/app/fleets/f1/quick-deploy-links"
[ "$status $body" = "200 api stand-in" ] || fail "the links' route reached '$status $body'"
# A route that keeps its query (the "query kept" canary: a fleets path,
# the links' among them, drops its own).
send "/api/v1/organizations/o1/configurations/c1/versions?limit=5"
[ "$status $body" = "200 api stand-in" ] || fail "a configuration's versions reached '$status $body'"
tf_sent=0
for entry in "${TF_REQUESTS[@]}"; do
  upstream=${entry%%|*}
  send "${entry#*|}"
  tf_sent=$((tf_sent + 1))
  [ "$status $body" = "200 $upstream stand-in" ] || fail "tf_ request case $tf_sent answered '$status', not the $upstream stand-in's 200"
done
tf_referred=0
for referer in "${TF_REFERERS[@]}"; do
  for path in "${TF_REFERRED_PATHS[@]}"; do
    send "$path" "$referer"
    tf_referred=$((tf_referred + 1))
    [ "$status" = 200 ] || fail "$path with tf_ Referer case $tf_referred answered $status"
  done
done
tf_basic=0
for path in "${TF_BASIC_PATHS[@]}"; do
  basic_status=$(curl -s -o /dev/null -I -w '%{http_code}' -u "$TF:" "http://127.0.0.1:$PORT$path")
  tf_basic=$((tf_basic + 1))
  [ "$basic_status" = 200 ] || fail "tf_ Basic user name case $tf_basic answered $basic_status"
done
tf_agent=0
for value in "${TF_HEADER_VALUES[@]}"; do
  for path in "${TF_AGENT_PATHS[@]}"; do
    header_status=$(curl -s -o /dev/null -w '%{http_code}' -H "User-Agent: $value" "http://127.0.0.1:$PORT$path")
    tf_agent=$((tf_agent + 1))
    [ "$header_status" = 200 ] || fail "tf_ User-Agent case $tf_agent answered $header_status"
  done
done
tf_forwarded=0
for value in "${TF_HEADER_VALUES[@]}"; do
  for path in "${TF_FORWARDED_PATHS[@]}"; do
    header_status=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 198.51.100.7, $value" "http://127.0.0.1:$PORT$path")
    tf_forwarded=$((tf_forwarded + 1))
    [ "$header_status" = 200 ] || fail "tf_ X-Forwarded-For case $tf_forwarded answered $header_status"
  done
done
forwarded_status=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 198.51.100.7" "http://127.0.0.1:$PORT/api/v1/auth/me?forwarded=1")
[ "$forwarded_status" = 200 ] || fail "/api/v1/auth/me?forwarded=1 answered $forwarded_status"
read_logs $((sent + refused + referred + 4 + tf_sent + tf_referred + tf_basic + tf_agent + tf_forwarded + 1))

if printf '%s\n%s\n' "$access" "$errors" | grep -q "$TF_CANARY"; then
  fail "upstreams up: $(printf '%s\n%s\n' "$access" "$errors" | grep -c "$TF_CANARY") access or error log line(s) hold an API token (not printed)"
else
  echo "ok: upstreams up: no access or error log line holds an API token"
fi
# (A public path's lines all read alike: these are told from the Referer,
# User-Agent, X-Forwarded-For and Basic cases below by their other fields
# and the Basic cases' method, HEAD.)
tf_redacted=$(printf '%s\n' "$access" | grep -cE '"GET (/api/public/v1)?/\[redacted\] HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "-"$')
if [ "$tf_redacted" = "$tf_sent" ]; then
  echo "ok: upstreams up: each of the $tf_sent requests whose line holds tf_ is logged GET /[redacted] (a public path's, GET /api/public/v1/[redacted])"
else
  fail "upstreams up: $tf_redacted of $tf_sent requests whose line holds tf_ logged GET /[redacted] or GET /api/public/v1/[redacted]"
fi
tf_redacted=$(printf '%s\n' "$access" | grep -cE '"GET (/assets/token-referred\.js|/api/public/v1/\[redacted\]) HTTP/1\.1" 200 [0-9]+ "\[redacted\]" ')
if [ "$tf_redacted" = "$tf_referred" ]; then
  echo "ok: upstreams up: each of the $tf_referred requests whose Referer holds tf_ logs it as [redacted]"
else
  fail "upstreams up: $tf_redacted of $tf_referred requests whose Referer holds tf_ log it as [redacted]"
fi

tf_basic_logged=$(printf '%s\n' "$access" | grep -cE '^[0-9.]+ - - \[[^]]+\] "HEAD (/api/public/v1/\[redacted\]|/assets/basic-user\.js) HTTP/1\.1" 200 ')
if [ "$tf_basic_logged" = "$tf_basic" ]; then
  echo "ok: upstreams up: each of the $tf_basic requests sending a token as a Basic user name logs the user field as -"
else
  fail "upstreams up: $tf_basic_logged of $tf_basic requests sending a token as a Basic user name log the user field as - (lines not printed)"
fi
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_BASIC_CANARY"; then
  fail "upstreams up: a log line holds a token's Basic encoding (not printed)"
else
  echo "ok: upstreams up: no access or error log line holds a token's Basic encoding"
fi

tf_logged=$(printf '%s\n' "$access" | grep -cE '"GET (/assets/token-agent\.js|/api/public/v1/\[redacted\]) HTTP/1\.1" 200 [0-9]+ "-" "\[redacted\]" "-"$')
if [ "$tf_logged" = "$tf_agent" ]; then
  echo "ok: upstreams up: each of the $tf_agent requests whose User-Agent holds tf_ logs it as [redacted]"
else
  fail "upstreams up: $tf_logged of $tf_agent requests whose User-Agent holds tf_ log it as [redacted] (lines not printed)"
fi
tf_logged=$(printf '%s\n' "$access" | grep -cE '"GET (/assets/token-forwarded\.js|/api/public/v1/\[redacted\]) HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "\[redacted\]"$')
if [ "$tf_logged" = "$tf_forwarded" ]; then
  echo "ok: upstreams up: each of the $tf_forwarded requests whose X-Forwarded-For holds tf_ logs it as [redacted]"
else
  fail "upstreams up: $tf_logged of $tf_forwarded requests whose X-Forwarded-For holds tf_ log it as [redacted] (lines not printed)"
fi
if printf '%s\n' "$access" | grep -qE '"GET /api/v1/auth/me\?forwarded=1 HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "198\.51\.100\.7"$'; then
  echo "ok: an ordinary X-Forwarded-For is logged as before"
else
  fail "an ordinary X-Forwarded-For isn't logged as before"
fi

check_no_canary "upstreams up"
redacted=$(printf '%s\n' "$access" | grep -cF "$REDACTED 200 ")
if [ "$redacted" = "$sent" ]; then
  echo "ok: upstreams up: each of the $sent proxied requests holding the secret is logged redacted"
else
  fail "upstreams up: $redacted of $sent proxied requests holding the secret logged redacted"
fi
redacted=$(printf '%s\n' "$access" | grep -cF "$REDACTED 404 ")
if [ "$redacted" = "$refused" ]; then
  echo "ok: upstreams up: each of the $refused paths typed without /api/ is logged redacted, 404"
else
  fail "upstreams up: $redacted of $refused paths typed without /api/ logged redacted, 404"
fi
for ordinary in "/register?x=1" "/api/v1/auth/me?x=1" "/api/v1/organizations/o1/configurations/c1/versions?limit=5"; do
  if printf '%s\n' "$access" | grep -qF "\"GET $ordinary HTTP/1.1\" 200 "; then
    echo "ok: $ordinary is logged as before"
  else
    fail "$ordinary isn't logged as before"
  fi
done
if printf '%s\n' "$access" | grep -qF '"GET /api/v1/organizations/o1/fleets/f1/quick-deploy-links HTTP/1.1" 200 '; then
  echo "ok: the links' route is logged by its path, not redacted, without its query (a fleets path)"
else
  fail "the links' route isn't logged by its path without its query"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"GET (/assets/app\.js|/api/v1/auth/me) HTTP/1\.1" 200 [0-9]+ "\[redacted\]" ')
if [ "$redacted" = "$referred" ]; then
  echo "ok: upstreams up: each of the $referred requests whose Referer names a link logs it as [redacted]"
else
  fail "upstreams up: $redacted of $referred requests whose Referer names a link log it as [redacted]"
fi
for ordinary in "https://telflo.example/app/fleets?tab=groups" "https://telflo.example/app/fleets/f1/quick-deploy-links"; do
  if printf '%s\n' "$access" | grep -qF " \"$ordinary\" \"curl/"; then
    echo "ok: the Referer $ordinary is logged as before"
  else
    fail "the Referer $ordinary isn't logged as before"
  fi
done
first=$(printf '%s\n' "$access" | grep -F "$REDACTED" | head -n 1)
# The regex in a variable: bash 5.2 (Ubuntu's) parses this one written
# inline differently from bash 3.2 (macOS's) and never matches it.
main_re='^[0-9.]+ - - \[[^]]+\] "GET /api/v1/quick-deploy/\[redacted\] HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "-"$'
if [[ "$first" =~ $main_re ]]; then
  echo "ok: a redacted line keeps the image's main format"
else
  fail "a redacted line isn't in the main format: $first"
fi

# ---------------------------------------------------------------------------
# 2. The upstreams down: nothing listens where telflo-api and telflo-web point.
start_gateway down
sent=0
for path in "${API_SPELLINGS[@]}" "${WEB_TQD_PATHS[@]}"; do
  send "$path"
  sent=$((sent + 1))
  [ "$status" = 502 ] || fail "$path answered $status with the upstreams down, not 502"
done
refused=0
for path in "${NGINX_404_SPELLINGS[@]}"; do
  send "$path"
  refused=$((refused + 1))
  [ "$status $body" = "$NOT_FOUND" ] || fail "$(shown "$path") typed without /api/ answered '$status $(first_line "$body")' with the upstreams down, not nginx's '$NOT_FOUND'"
  [ "$content_type" = "$NOT_FOUND_TYPE" ] || fail "$(shown "$path") typed without /api/ answered Content-Type '$content_type' with the upstreams down, not $NOT_FOUND_TYPE"
done
send "/api/v1/auth/me?x=1"
[ "$status" = 502 ] || fail "/api/v1/auth/me?x=1 answered $status with the API down, not 502"
read_logs $((sent + refused + 1))

check_no_canary "upstreams down"
redacted=$(printf '%s\n' "$access" | grep -cF "$REDACTED 502 ")
if [ "$redacted" = "$sent" ]; then
  echo "ok: upstreams down: each of the $sent proxied requests holding the secret is logged redacted, 502"
else
  fail "upstreams down: $redacted of $sent proxied requests holding the secret logged redacted, 502"
fi
redacted=$(printf '%s\n' "$access" | grep -cF "$REDACTED 404 ")
if [ "$redacted" = "$refused" ]; then
  echo "ok: upstreams down: each of the $refused paths typed without /api/ is logged redacted, 404"
else
  fail "upstreams down: $redacted of $refused paths typed without /api/ logged redacted, 404"
fi
if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF 'request: "GET /api/v1/auth/me?x=1 HTTP/1.1"'; then
  echo "ok: an ordinary request's upstream failure is in the error log"
else
  fail "an ordinary request's upstream failure isn't in the error log, so the check proves nothing"
fi

# ---------------------------------------------------------------------------
# 3. A library link, the upstreams up, on a fresh container (its own logs).

# $1 for a message, the link's random part cut.
shown_link() {
  printf '%s' "${1//$LL_BODY/…}"
}

# Fails, naming $1, when an access or error log line holds the link.
check_no_link() {
  if printf '%s\n%s\n' "$access" "$errors" | grep -q "$LL_CANARY"; then
    fail "$1: $(printf '%s\n%s\n' "$access" "$errors" | grep -c "$LL_CANARY") log line(s) hold a library link (not printed)"
  else
    echo "ok: $1: no access or error log line holds a library link"
  fi
}

# The paths that hold a link and reach the API's location: as spelt, with
# a query, doubled slashes, an encoded slash, upper case, dot segments,
# encoded letters, an encoded prefix (each letter), a trailing slash; and
# a link in an organization's and a library file's path.
LINK_API_SPELLINGS=(
  "/api/v1/library-links/$LINK"
  "/api/v1/library-links/$LINK?x=1"
  "//api/v1/library-links/$LINK"
  "/api/v1//library-links/$LINK"
  "/api/v1/library-links%2F$LINK"
  "/API/V1/LIBRARY-LINKS/$LINK"
  "/api/v1/x/../library-links/$LINK"
  "/api/v1/./library-links/$LINK"
  "/api/v1/%6cibrary-links/%74ll_$LL_BODY"
  "/api/v1/library-links/tll%5F$LL_BODY"
  "/api/v1/library-links/t%6Cl_$LL_BODY"
  "/api/v1/library-links/$LINK/"
  "/api/v1/library-links/$LINK/../x"
  "/api/v1/organizations/$LINK"
  "/api/v1/library-files/$LINK"
  "/api/v1/library-files/$LINK/link"
)
# The same typed without /api/: nginx's own plain-text 404, never proxied.
# The tqd_x.js case is the locations' order: the library's 404 comes
# before the tqd_ web location.
LINK_404_SPELLINGS=(
  "/library-links/$LINK"
  "/LIBRARY-LINKS/$LINK?x=1"
  "//library-links/$LINK"
  "/%6cibrary-links/$LINK"
  "/library-links%2F$LINK"
  "/x%2Flibrary-links/$LINK"
  "/x/../library-links/$LINK"
  "/app/library-links/$LINK"
  "/library-links?s=$LINK"
  "/library-links/x.html"
  "/library-links/tqd_x.js"
  "/library-links/tll_x.js"
  "/library-links"
)
# A web path holding tll_ elsewhere: the web app's.
LINK_WEB_PATHS=(
  "/assets/tll_chunk.js"
  "/x/$LINK"
)
# A link in another path's query, each letter of its prefix encoded or not.
LINK_QUERY_SPELLINGS=(
  "/api/v1/auth/me?s=$LINK"
  "/register?s=tll%5F$LL_BODY"
  "/api/v1/auth/me?s=%74ll_$LL_BODY"
  "/api/v1/auth/me?s=t%6cl_$LL_BODY"
  "/register?s=tl%6C_$LL_BODY"
  "/register?s=%54%4C%4c%5f$LL_BODY"
)
# A Referer naming a link: through the API, typed without /api/, letters
# encoded, in another page's query, behind an encoded slash.
LINK_REFERERS=(
  "https://telflo.example/api/v1/library-links/$LINK"
  "https://telflo.example/library-links/$LINK"
  "https://telflo.example/x/%74ll_$LL_BODY"
  "https://telflo.example/x/t%6cl%5F$LL_BODY"
  "https://telflo.example/forgot-password?s=%54LL_$LL_BODY"
  "https://telflo.example/library-links%2F$LL_BODY"
)
# A User-Agent and an X-Forwarded-For holding a link: as spelt, after other
# text, upper case, each letter encoded, all of them.
LINK_HEADER_VALUES=(
  "$LINK"
  "x/1.0 TLL_$LL_BODY"
  "%74ll_$LL_BODY"
  "t%6cl_$LL_BODY"
  "tl%4C_$LL_BODY"
  "tll%5f$LL_BODY"
  "%54%4C%4c%5F$LL_BODY"
)
# The library's ordinary paths: logged as before, Referer and all.
LINK_ORDINARY_PATHS=(
  "/library"
  "/product-admin/library"
  "/api/v1/library-files"
  "/api/v1/library-files/0190a0a0-0000-7000-8000-000000000001/link"
  "/api/v1/library-files/0190a0a0-0000-7000-8000-000000000001/file"
  "/api/v1/organization-logos/0190a0a0-0000-7000-8000-000000000001/0190a0a0-0000-7000-8000-000000000002"
)
LINK_REDACTED='"GET /api/v1/library-links/[redacted] HTTP/1.1"'

start_gateway up
sent=0
for path in "${LINK_API_SPELLINGS[@]}"; do
  send "$path"
  sent=$((sent + 1))
  [ "$status $body" = "200 api stand-in" ] || fail "$(shown_link "$path") reached '$status', not the API"
done
web_before=$(web_requests)
refused=0
for path in "${LINK_404_SPELLINGS[@]}"; do
  send "$path"
  refused=$((refused + 1))
  [ "$status $body" = "$NOT_FOUND" ] || fail "$(shown_link "$path") typed without /api/ answered '$status', not nginx's '$NOT_FOUND'"
  [ "$content_type" = "$NOT_FOUND_TYPE" ] || fail "$(shown_link "$path") typed without /api/ answered Content-Type '$content_type', not $NOT_FOUND_TYPE"
done
web_after=$(web_requests)
if [ -n "$web_before" ] && [ "$web_after" = "$web_before" ]; then
  echo "ok: library link: each of the $refused paths typed without /api/ is nginx's '$NOT_FOUND' ($NOT_FOUND_TYPE), the web stand-in receiving none"
else
  fail "library link: the web stand-in received $((web_after - web_before)) of the $refused paths typed without /api/"
fi
web_sent=0
for path in "${LINK_WEB_PATHS[@]}"; do
  web_before=$(web_requests)
  send "$path"
  web_sent=$((web_sent + 1))
  web_after=$(web_requests)
  if [ "$status $body" = "200 web stand-in" ] && [ "$web_after" = "$((web_before + 1))" ]; then
    echo "ok: $(shown_link "$path") reaches the web stand-in"
  else
    fail "$(shown_link "$path") answered '$status', the web stand-in counting '$web_before' then '$web_after', not the web app's"
  fi
done
queried=0
for path in "${LINK_QUERY_SPELLINGS[@]}"; do
  send "$path"
  queried=$((queried + 1))
  [ "$status" = 200 ] || fail "library link query case $queried answered $status"
done
referred=0
for referer in "${LINK_REFERERS[@]}"; do
  send /assets/link-referred.js "$referer"
  referred=$((referred + 1))
  [ "$status" = 200 ] || fail "library link Referer case $referred answered $status"
done
agent=0
for value in "${LINK_HEADER_VALUES[@]}"; do
  header_status=$(curl -s -o /dev/null -w '%{http_code}' -H "User-Agent: $value" "http://127.0.0.1:$PORT/api/v1/link-agent")
  agent=$((agent + 1))
  [ "$header_status" = 200 ] || fail "library link User-Agent case $agent answered $header_status"
done
forwarded=0
for value in "${LINK_HEADER_VALUES[@]}"; do
  header_status=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 198.51.100.7, $value" "http://127.0.0.1:$PORT/assets/link-forwarded.js")
  forwarded=$((forwarded + 1))
  [ "$header_status" = 200 ] || fail "library link X-Forwarded-For case $forwarded answered $header_status"
done
ordinary=0
for path in "${LINK_ORDINARY_PATHS[@]}"; do
  send "$path" "https://telflo.example/library"
  ordinary=$((ordinary + 1))
  [ "$status" = 200 ] || fail "$path answered $status"
done
read_logs $((sent + refused + web_sent + queried + referred + agent + forwarded + ordinary))

check_no_link "library link, upstreams up"
redacted=$(printf '%s\n' "$access" | grep -cF "$LINK_REDACTED 200 ")
expected=$((sent + web_sent + queried))
if [ "$redacted" = "$expected" ]; then
  echo "ok: library link, upstreams up: each of the $expected proxied requests holding a link is logged redacted"
else
  fail "library link, upstreams up: $redacted of $expected proxied requests holding a link logged redacted"
fi
# The 404s: the library's line, or quick-deploy's for the path holding tqd_ too.
redacted=$(printf '%s\n' "$access" | grep -cE '"GET /api/v1/(library-links|quick-deploy)/\[redacted\] HTTP/1\.1" 404 ')
if [ "$redacted" = "$refused" ]; then
  echo "ok: library link, upstreams up: each of the $refused paths typed without /api/ is logged redacted, 404"
else
  fail "library link, upstreams up: $redacted of $refused paths typed without /api/ logged redacted, 404"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"GET /assets/link-referred\.js HTTP/1\.1" 200 [0-9]+ "\[redacted\]" ')
if [ "$redacted" = "$referred" ]; then
  echo "ok: library link: each of the $referred requests whose Referer names a link logs it as [redacted]"
else
  fail "library link: $redacted of $referred requests whose Referer names a link log it as [redacted]"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"GET /api/v1/link-agent HTTP/1\.1" 200 [0-9]+ "-" "\[redacted\]" "-"$')
if [ "$redacted" = "$agent" ]; then
  echo "ok: library link: each of the $agent requests whose User-Agent holds tll_ logs it as [redacted]"
else
  fail "library link: $redacted of $agent requests whose User-Agent holds tll_ log it as [redacted] (lines not printed)"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"GET /assets/link-forwarded\.js HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "\[redacted\]"$')
if [ "$redacted" = "$forwarded" ]; then
  echo "ok: library link: each of the $forwarded requests whose X-Forwarded-For holds tll_ logs it as [redacted]"
else
  fail "library link: $redacted of $forwarded requests whose X-Forwarded-For holds tll_ log it as [redacted] (lines not printed)"
fi
for path in "${LINK_ORDINARY_PATHS[@]}"; do
  if printf '%s\n' "$access" | grep -qF "\"GET $path HTTP/1.1\" 200 " &&
    printf '%s\n' "$access" | grep -F "\"GET $path HTTP/1.1\" 200 " | grep -qF ' "https://telflo.example/library" "curl/'; then
    echo "ok: $path is logged as before"
  else
    fail "$path isn't logged as before"
  fi
done

# ---------------------------------------------------------------------------
# 4. The same link, the upstreams down.
start_gateway down
sent=0
for path in "${LINK_API_SPELLINGS[@]}" "${LINK_WEB_PATHS[@]}"; do
  send "$path"
  sent=$((sent + 1))
  [ "$status" = 502 ] || fail "$(shown_link "$path") answered $status with the upstreams down, not 502"
done
refused=0
for path in "${LINK_404_SPELLINGS[@]}"; do
  send "$path"
  refused=$((refused + 1))
  [ "$status $body" = "$NOT_FOUND" ] || fail "$(shown_link "$path") typed without /api/ answered '$status' with the upstreams down, not nginx's '$NOT_FOUND'"
done
send "/api/v1/auth/me?x=1"
[ "$status" = 502 ] || fail "/api/v1/auth/me?x=1 answered $status with the API down, not 502"
read_logs $((sent + refused + 1))

check_no_link "library link, upstreams down"
redacted=$(printf '%s\n' "$access" | grep -cF "$LINK_REDACTED 502 ")
if [ "$redacted" = "$sent" ]; then
  echo "ok: library link, upstreams down: each of the $sent proxied requests holding a link is logged redacted, 502"
else
  fail "library link, upstreams down: $redacted of $sent proxied requests holding a link logged redacted, 502"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"GET /api/v1/(library-links|quick-deploy)/\[redacted\] HTTP/1\.1" 404 ')
if [ "$redacted" = "$refused" ]; then
  echo "ok: library link, upstreams down: each of the $refused paths typed without /api/ is logged redacted, 404"
else
  fail "library link, upstreams down: $redacted of $refused paths typed without /api/ logged redacted, 404"
fi
if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF 'request: "GET /api/v1/auth/me?x=1 HTTP/1.1"'; then
  echo "ok: library link: an ordinary request's upstream failure is in the error log"
else
  fail "library link: an ordinary request's upstream failure isn't in the error log, so the check proves nothing"
fi

# ---------------------------------------------------------------------------
# 5. The public surface, the upstreams up, on a fresh container (its own
# logs).

# A validation pipeline's name in route 14's path (configuration text): a
# marker no log line may hold.
PIPELINE_MARKER=PIPELINENAMEMARKER
PIPELINES=/api/public/v1/configurations/c1/versions/1/validation-pipelines
# $1 for a message, the canaries cut.
shown_public() {
  local text="${1//$TF_BODY/…}"
  printf '%s' "${text//$PIPELINE_MARKER/…}"
}
# [the upstream's reply, the path as sent]: the seven tf_ cases,
# then the pipeline name raw, behind an encoded slash, in the query, mixed
# case (to the API: the public location matches case aside),
# runs of slashes, dot segments, the prefix's letters and slash encoded, a
# letter doubly encoded (nginx decodes once; the API decodes again), the
# public list's query, and dot segments encoded twice after another
# segment (the API resolves them; nginx doesn't).
PUBLIC_REQUESTS=(
  "api|/api/public/v1/configurations?cursor=$TF"
  "api|/api/public/v1/configurations/$TF/versions/1"
  "api|/api/public/v1/test-runs?x=$TF"
  "api|/api/public/v1/test-runs/$TF/output"
  "api|/api/public/v1/ottl/lint?t=%74f_$TF_BODY"
  "api|/api/public/v1/validation-pipelines/traces%2F$TF"
  "api|/api/public/v1/docs/$TF"
  "api|$PIPELINES/traces/$PIPELINE_MARKER"
  "api|$PIPELINES/traces%2F$PIPELINE_MARKER"
  "api|$PIPELINES?q=$PIPELINE_MARKER"
  "api|$PIPELINES/$PIPELINE_MARKER?q=$PIPELINE_MARKER"
  "api|/API/Public/V1/configurations/c1/versions/1/Validation-Pipelines/$PIPELINE_MARKER"
  "api|/Api/PUBLIC/v1/configurations?q=$PIPELINE_MARKER"
  "api|//api//public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/./public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/x/../public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/%70ublic/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/public%2Fv1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/public/v1%2fconfigurations%2Fc1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/%2570ublic/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/public/%2576%2531/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/x/%252e%252e/public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/x%252f..%252fpublic/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/x/%25252e%25252e/public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|/api/public/x/%252E%252E/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
)
# Absolute-form request lines (curl --request-target): [upstream, target].
PUBLIC_ABSOLUTE_TARGETS=(
  "api|http://telflo.example$PIPELINES/$PIPELINE_MARKER?q=$PIPELINE_MARKER"
  "api|http://telflo.example/API/public/v1/configurations/c1/versions/1/validation-pipelines/$PIPELINE_MARKER"
  "api|http://telflo.example/api/public/v1/whoami?t=$TF"
)

start_gateway up
public_sent=0
for entry in "${PUBLIC_REQUESTS[@]}"; do
  upstream=${entry%%|*}
  send "${entry#*|}"
  public_sent=$((public_sent + 1))
  [ "$status $body" = "200 $upstream stand-in" ] || fail "public case $public_sent ($(shown_public "${entry#*|}")) answered '$status', not the $upstream stand-in's 200"
done
for entry in "${PUBLIC_ABSOLUTE_TARGETS[@]}"; do
  upstream=${entry%%|*}
  body=$(curl -s --path-as-is --request-target "${entry#*|}" -w '\n%{http_code}' "http://127.0.0.1:$PORT/")
  status=${body##*$'\n'}
  body=${body%$'\n'*}
  public_sent=$((public_sent + 1))
  [ "$status $body" = "200 $upstream stand-in" ] || fail "public absolute-form case $public_sent answered '$status', not the $upstream stand-in's 200"
done
ordinary_sent=0
for path in "/api/v1/auth/me?x=1" "/register?x=1" "/api/v1/organizations/o1/configurations/c1/versions?limit=5"; do
  send "$path"
  ordinary_sent=$((ordinary_sent + 1))
  [ "$status" = 200 ] || fail "$path answered $status"
done

# The public body limits: [the status expected, the size in bytes, the path].
# A body under each limit reaches the API; one a little over is nginx's 413.
PUBLIC_BODIES=(
  "200|1500000|/api/public/v1/validate"
  "413|2300000|/api/public/v1/validate"
  "200|1500000|/api/public/v1/ottl/lint"
  "413|2300000|/api/public/v1/ottl/lint"
  "200|1500000|/api/public/v1/configurations"
  "413|2300000|/api/public/v1/configurations"
  "200|1500000|/api/public/v1/configurations/c1/versions"
  "200|1500000|/api/public/v1/configurations/c1/versions/2"
  "413|2300000|/api/public/v1/configurations/c1/versions/2"
  "200|8000000|/api/public/v1/test-runs"
  "413|8700000|/api/public/v1/test-runs"
  "413|1500000|/api/public/v1/fleets"
  "413|1500000|/api/public/v1/test-runs/r1"
  "200|900000|/api/public/v1/fleets"
  "413|1500000|$PIPELINES/logs/$PIPELINE_MARKER?q=$PIPELINE_MARKER"
  "413|2300000|/api/public/v1/validate?q=$PIPELINE_MARKER"
)
body_sent=0
for entry in "${PUBLIC_BODIES[@]}"; do
  expected=${entry%%|*}
  rest=${entry#*|}
  size=${rest%%|*}
  path=${rest#*|}
  [ -f "$work/body-$size" ] || head -c "$size" /dev/zero | tr '\0' 'a' >"$work/body-$size"
  method=POST
  [[ "$path" =~ /versions/[^/]+$ ]] && method=PATCH
  [[ "$path" == *validation-pipelines/* ]] && method=PUT
  body_status=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data-binary "@$work/body-$size" "http://127.0.0.1:$PORT$path")
  body_sent=$((body_sent + 1))
  if [ "$body_status" = "$expected" ]; then
    echo "ok: $method $(shown_public "$path") with $size bytes answered $expected"
  else
    fail "$method $(shown_public "$path") with $size bytes answered $body_status, not $expected"
  fi
done
read_logs $((public_sent + ordinary_sent + body_sent))

if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  fail "public surface: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$TF_CANARY") access or error log line(s) hold an API token (not printed)"
else
  echo "ok: public surface: no access or error log line holds an API token"
fi
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$PIPELINE_MARKER"; then
  fail "public surface: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$PIPELINE_MARKER") access or error log line(s) hold a pipeline's name (not printed)"
else
  echo "ok: public surface: no access or error log line holds a pipeline's name"
fi
redacted=$(printf '%s\n' "$access" | grep -cF "$PUBLIC_REDACTED 200 ")
if [ "$redacted" = "$public_sent" ]; then
  echo "ok: public surface: each of the $public_sent requests under /api/public/v1 is logged GET /api/public/v1/[redacted]"
else
  fail "public surface: $redacted of $public_sent requests under /api/public/v1 logged GET /api/public/v1/[redacted]"
fi
redacted=$(printf '%s\n' "$access" | grep -cE '"(POST|PATCH|PUT) /api/public/v1/\[redacted\] HTTP/1\.1" (200|413) ')
if [ "$redacted" = "$body_sent" ]; then
  echo "ok: public surface: each of the $body_sent writes is logged METHOD /api/public/v1/[redacted]"
else
  fail "public surface: $redacted of $body_sent writes logged METHOD /api/public/v1/[redacted]"
fi
for ordinary in "/api/v1/auth/me?x=1" "/register?x=1" "/api/v1/organizations/o1/configurations/c1/versions?limit=5"; do
  if printf '%s\n' "$access" | grep -qF "\"GET $ordinary HTTP/1.1\" 200 "; then
    echo "ok: $ordinary is logged as before"
  else
    fail "$ordinary isn't logged as before"
  fi
done
first=$(printf '%s\n' "$access" | grep -F "$PUBLIC_REDACTED" | head -n 1)
# The regex in a variable: bash 5.2 (Ubuntu's) parses this one written
# inline differently from bash 3.2 (macOS's) and never matches it.
main_re='^[0-9.]+ - - \[[^]]+\] "GET /api/public/v1/\[redacted\] HTTP/1\.1" 200 [0-9]+ "-" "curl/[^"]+" "-"$'
if [[ "$first" =~ $main_re ]]; then
  echo "ok: a public line keeps the image's main format"
else
  fail "a public line isn't in the main format: $(shown_public "$first")"
fi

# The public map reads a request line in linear time. The unanchored
# pattern backtracked in the cube of a line's length on a line of /api/public
# repeated with no v1: 6,600 characters held a worker for 20 s (at 8 KiB
# PCRE's match limit cut it short). A long public path (many /api, then
# /public, many /x, then /v1) is answered, and logged redacted, in time too.
# The map runs in the log phase, after the reply is sent, so each line is
# followed by a short request on the same connection, which the worker
# answers only once the first is logged: the two together, under a second.
# Prints the seconds GET $1 and then GET / took on one connection.
two_on_one_connection() {
  curl -s --path-as-is -o /dev/null -o /dev/null -w '%{time_total}\n' \
    "http://127.0.0.1:$PORT$1" "http://127.0.0.1:$PORT/" | awk '{ total += $1 } END { printf "%.3f", total }'
}
under_a_second() { awk -v s="$1" 'BEGIN { exit !(s < 1) }'; }
for repeats in 200 400 600 700; do
  target=$(printf '/api/public%.0s' $(seq 1 "$repeats"))
  seconds=$(two_on_one_connection "$target")
  if under_a_second "$seconds"; then
    echo "ok: a ${#target}-character line of /api/public, no v1, answered and logged in ${seconds}s"
  else
    fail "a ${#target}-character line of /api/public, no v1, took ${seconds}s (the public map backtracks)"
  fi
done
long_public="$(printf '/api%.0s' $(seq 1 600))/public$(printf '/x%.0s' $(seq 1 600))/v1/$PIPELINE_MARKER"
seconds=$(two_on_one_connection "$long_public")
sleep 0.5
if under_a_second "$seconds" && ! docker logs "$CONTAINER" 2>&1 | grep -qF "$PIPELINE_MARKER"; then
  echo "ok: a ${#long_public}-character public line answered and logged in ${seconds}s, redacted"
else
  fail "a ${#long_public}-character public line took ${seconds}s or was logged with its pipeline name (the public location backtracks)"
fi

# ---------------------------------------------------------------------------
# 6. The public surface, the upstreams down: nginx's error log quotes a
# request line when its upstream fails, so every public location logs crit
# and worse only. Each public spelling above (and the absolute forms, and
# route 14's body over its limit, a 413) is answered 502 (413) with no access
# or error log line holding a tf_ canary or the pipeline's name, while an
# ordinary API path's failure is still in the error log.
start_gateway down
down_sent=0
for entry in "${PUBLIC_REQUESTS[@]}"; do
  send "${entry#*|}"
  down_sent=$((down_sent + 1))
  [ "$status" = 502 ] || fail "public case $down_sent ($(shown_public "${entry#*|}")) answered $status with the upstreams down, not 502"
done
for entry in "${PUBLIC_ABSOLUTE_TARGETS[@]}"; do
  status=$(curl -s -o /dev/null --path-as-is --request-target "${entry#*|}" -w '%{http_code}' "http://127.0.0.1:$PORT/")
  down_sent=$((down_sent + 1))
  [ "$status" = 502 ] || fail "public absolute-form case $down_sent answered $status with the upstreams down, not 502"
done
too_large=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' --data-binary "@$work/body-1500000" \
  "http://127.0.0.1:$PORT$PIPELINES/logs/$PIPELINE_MARKER?q=$PIPELINE_MARKER")
[ "$too_large" = 413 ] || fail "route 14's PUT over 1 MiB answered $too_large with the upstreams down, not 413"
send "/api/v1/auth/me?x=1"
[ "$status" = 502 ] || fail "/api/v1/auth/me?x=1 answered $status with the API down, not 502"
read_logs $((down_sent + 2))

if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  fail "public surface, upstreams down: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$TF_CANARY") access or error log line(s) hold an API token (not printed)"
else
  echo "ok: public surface, upstreams down: no access or error log line holds an API token"
fi
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$PIPELINE_MARKER"; then
  fail "public surface, upstreams down: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$PIPELINE_MARKER") access or error log line(s) hold a pipeline's name (not printed)"
else
  echo "ok: public surface, upstreams down: no access or error log line holds a pipeline's name"
fi
redacted=$(printf '%s\n' "$access" | grep -cF "$PUBLIC_REDACTED 502 ")
if [ "$redacted" = "$down_sent" ]; then
  echo "ok: public surface, upstreams down: each of the $down_sent requests is logged GET /api/public/v1/[redacted], 502"
else
  fail "public surface, upstreams down: $redacted of $down_sent requests logged GET /api/public/v1/[redacted], 502"
fi
if printf '%s\n' "$access" | grep -qF '"PUT /api/public/v1/[redacted] HTTP/1.1" 413 '; then
  echo "ok: route 14's PUT over 1 MiB is logged PUT /api/public/v1/[redacted], 413"
else
  fail "route 14's PUT over 1 MiB isn't logged PUT /api/public/v1/[redacted], 413"
fi
if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF 'request: "GET /api/v1/auth/me?x=1 HTTP/1.1"'; then
  echo "ok: public surface: an ordinary request's upstream failure is still in the error log"
else
  fail "public surface: an ordinary request's upstream failure isn't in the error log, so the check proves nothing"
fi

# ---------------------------------------------------------------------------
# 7. Product administration, the upstreams up, on a fresh container: a
# search term in a product-admin request's query reaches no log line, each
# line the method, the path as nginx routes it, the protocol.
# A made-up address (never a person's), raw and percent-encoded in a query.
PA_MARKER_LOCAL="pa-search-marker-$$"
PA_MARKER="$PA_MARKER_LOCAL@example.com"
PA_QUERIES=("?q=$PA_MARKER" "?q=${PA_MARKER_LOCAL}%40example.com&cursor=abc" "?cursor=$PA_MARKER_LOCAL")
# [the path as sent|the path as nginx routes it ($uri)].
PA_PATHS=(
  "/api/v1/product-admin/users|/api/v1/product-admin/users"
  "/api/v1/product-admin/feedback|/api/v1/product-admin/feedback"
  "/api/v1/product-admin|/api/v1/product-admin"
  "//api/v1//product-admin/users|/api/v1/product-admin/users"
  "/api/v1/x/../product-admin/users|/api/v1/product-admin/users"
  "/api/v1/./product-admin/product-admins|/api/v1/product-admin/product-admins"
  "/api/v1/%70roduct-admin/users|/api/v1/product-admin/users"
)
start_gateway up
pa_sent=0
for entry in "${PA_PATHS[@]}"; do
  for query in "${PA_QUERIES[@]}"; do
    send "${entry%%|*}$query"
    pa_sent=$((pa_sent + 1))
    [ "$status $body" = "200 api stand-in" ] || fail "product-admin case $pa_sent answered '$status', not the API's"
  done
done
send "/API/V1/PRODUCT-ADMIN/users?q=$PA_MARKER"
[ "$status" = 200 ] || fail "the upper-case product-admin path answered $status"
send "/api/v1/product-admin/users/$TF?q=$PA_MARKER"
[ "$status $body" = "200 api stand-in" ] || fail "a product-admin path holding tf_ answered '$status', not the API's"
send "/api/v1/auth/me?x=1"
read_logs $((pa_sent + 3))
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$PA_MARKER_LOCAL"; then
  fail "product administration: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$PA_MARKER_LOCAL") access or error log line(s) hold the search term (not printed)"
else
  echo "ok: product administration: no access or error log line holds the search term"
fi
logged=$(printf '%s\n' "$access" | grep -cE '"GET /api/v1/product-admin(/[a-z-]+)? HTTP/1\.1" 200 ')
if [ "$logged" = "$pa_sent" ]; then
  echo "ok: product administration: each of the $pa_sent requests is logged GET <its path> HTTP/1.1, without its query"
else
  fail "product administration: $logged of $pa_sent requests logged GET <its path> HTTP/1.1"
fi
if printf '%s\n' "$access" | grep -qF '"GET /API/V1/PRODUCT-ADMIN/users HTTP/1.1" 200 '; then
  echo "ok: product administration: another case is logged without its query too"
else
  fail "product administration: the upper-case path isn't logged without its query"
fi
if printf '%s\n' "$access" | grep -qF "$TF_REDACTED 200 " && ! printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  echo "ok: product administration: a path holding tf_ is the tf_ line, the token in no log line"
else
  fail "product administration: a path holding tf_ isn't the tf_ line, or a log line holds the token (not printed)"
fi
if printf '%s\n' "$access" | grep -qF '"GET /api/v1/auth/me?x=1 HTTP/1.1" 200 '; then
  echo "ok: product administration: an ordinary path is logged as before"
else
  fail "product administration: an ordinary path isn't logged as before"
fi

# ---------------------------------------------------------------------------
# 8. Product administration, the upstreams down: nginx's error log would
# quote the request line, query and all, so the location logs crit only.
start_gateway down
pa_down=0
for entry in "${PA_PATHS[@]}"; do
  for query in "${PA_QUERIES[@]}"; do
    send "${entry%%|*}$query"
    pa_down=$((pa_down + 1))
    [ "$status" = 502 ] || fail "product-admin case $pa_down answered $status with the API down, not 502"
  done
done
send "/api/v1/auth/me?x=1"
[ "$status" = 502 ] || fail "/api/v1/auth/me?x=1 answered $status with the API down, not 502"
read_logs $((pa_down + 1))
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$PA_MARKER_LOCAL"; then
  fail "product administration, upstreams down: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$PA_MARKER_LOCAL") access or error log line(s) hold the search term (not printed)"
else
  echo "ok: product administration, upstreams down: no access or error log line holds the search term"
fi
logged=$(printf '%s\n' "$access" | grep -cE '"GET /api/v1/product-admin(/[a-z-]+)? HTTP/1\.1" 502 ')
if [ "$logged" = "$pa_down" ]; then
  echo "ok: product administration, upstreams down: each of the $pa_down requests is logged without its query, 502"
else
  fail "product administration, upstreams down: $logged of $pa_down requests logged without their query, 502"
fi
if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF 'request: "GET /api/v1/auth/me?x=1 HTTP/1.1"'; then
  echo "ok: product administration: an ordinary request's upstream failure is still in the error log"
else
  fail "product administration: an ordinary request's upstream failure isn't in the error log, so the check proves nothing"
fi

# ---------------------------------------------------------------------------
# Sections 9 to 11 check every access log line exactly.

# The access log's lines after the first (start_gateway's own request), each
# "<request field> <status>", sorted.
logged_requests() {
  printf '%s\n' "$access" | tail -n +2 | sed -n 's/^[0-9.]* - - \[[^]]*\] "\([^"]*\)" \([0-9][0-9]*\) .*/\1 \2/p' | sort
}

# Passes, naming $1, when the access log's lines (but start_gateway's) are
# exactly the file $2's, in any order; else fails and shows the
# differences, the secrets' random parts cut.
check_lines() {
  logged_requests >"$work/logged"
  sort "$2" >"$work/expected"
  if cmp -s "$work/logged" "$work/expected"; then
    echo "ok: $1: each of the $(grep -c . "$work/expected") requests is logged exactly as expected"
  else
    fail "$1: the access log's lines aren't the expected ones (expected <, logged >; secrets cut):"
    diff "$work/expected" "$work/logged" | sed -e "s/$TF_BODY/…/g" -e "s/$BODY/…/g"
  fi
}

# Fails, naming $1, when an access or error log line holds the marker $2.
check_no_marker() {
  if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$2"; then
    fail "$1: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$2") access or error log line(s) hold its marker"
  else
    echo "ok: $1: no access or error log line holds its marker"
  fi
}

# Fails, naming $1, unless the error log holds an upstream's failure for the request line $2.
check_failure_logged() {
  if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF "request: \"$2\""; then
    echo "ok: $1: its upstream's failure is in the error log"
  else
    fail "$1: its upstream's failure isn't in the error log, so the check proves nothing"
  fi
}

# ---------------------------------------------------------------------------
# 8a. The email confirmation, the upstreams up, on a fresh container: a link
# sent before the token moved to the fragment carried it in the query
# (/verify-email?token=…). No access or error log line holds it: the line is
# the method, the path as nginx routes it, the protocol, and a Referer naming
# the page (its asset loads would repeat the query) is "[redacted]".
VERIFY_MARKER="verifytokenmarker$$"
VERIFY_PATHS=("/verify-email" "/verify-email/" "//verify-email" "/Verify-Email" "/x/../verify-email")
start_gateway up
verify_sent=0
for path in "${VERIFY_PATHS[@]}"; do
  send "$path?token=$VERIFY_MARKER&utm_source=mail"
  verify_sent=$((verify_sent + 1))
  [ "$status $body" = "200 web stand-in" ] || fail "verify-email case $verify_sent answered '$status', not the web app's"
done
send "/assets/app.js" "http://localhost/verify-email?token=$VERIFY_MARKER"
send "/verify-email#token=$VERIFY_MARKER"
read_logs $((verify_sent + 2))
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$VERIFY_MARKER"; then
  fail "email confirmation: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$VERIFY_MARKER") access or error log line(s) hold the token (not printed)"
else
  echo "ok: email confirmation: no access or error log line holds the token, in a query or a Referer"
fi
logged=$(printf '%s\n' "$access" | grep -ciE '"GET /verify-email/? HTTP/1\.1" 200 ')
if [ "$logged" -ge "$verify_sent" ]; then
  echo "ok: email confirmation: each of the $verify_sent requests is logged GET <its path> HTTP/1.1, without its query"
else
  fail "email confirmation: $logged of $verify_sent requests logged GET <its path> HTTP/1.1"
fi

# 8b. The same, the upstreams down: nginx's error log would quote the request
# line, query and all, so the location logs crit only.
start_gateway down
verify_down=0
for path in "${VERIFY_PATHS[@]}"; do
  send "$path?token=$VERIFY_MARKER"
  verify_down=$((verify_down + 1))
  [ "$status" = 502 ] || fail "verify-email case $verify_down answered $status with the web app down, not 502"
done
send "/login?x=1"
read_logs $((verify_down + 1))
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$VERIFY_MARKER"; then
  fail "email confirmation, upstreams down: $(printf '%s\n%s\n' "$access" "$errors" | grep -cF "$VERIFY_MARKER") access or error log line(s) hold the token (not printed)"
else
  echo "ok: email confirmation, upstreams down: no access or error log line holds the token"
fi
if printf '%s\n' "$errors" | grep -F 'connect() failed' | grep -qF 'request: "GET /login?x=1 HTTP/1.1"'; then
  echo "ok: email confirmation: an ordinary web request's upstream failure is still in the error log"
else
  fail "email confirmation: an ordinary web request's upstream failure isn't in the error log, so the check proves nothing"
fi

# ---------------------------------------------------------------------------
# 9. An organization's fleets, its configurations list and the open flow
# read, the upstreams up, on a fresh container.
FLEET_MARKER="fleet-query-marker-$$"
CONF_MARKER="configurations-query-marker-$$"
FLOW_MARKER="flow-slug-marker-$$"
ORG=/api/v1/organizations/o1
PF=/api/v1/published-flows
# [the upstream's reply|the path as sent|its line's path]: no query, no slug.
DROPPED_REQUESTS=(
  "api|$ORG/fleets?q=$FLEET_MARKER|$ORG/fleets"
  "api|$ORG/fleets/?cursor=$FLEET_MARKER|$ORG/fleets/"
  "api|$ORG/fleets/f1/collectors?q=$FLEET_MARKER&limit=5|$ORG/fleets/f1/collectors"
  "api|$ORG/fleets/f1/groups/g1?q=$FLEET_MARKER|$ORG/fleets/f1/groups/g1"
  "api|//api/v1//organizations/o1//fleets/f1?q=$FLEET_MARKER|$ORG/fleets/f1"
  "api|$ORG/x/../fleets?q=$FLEET_MARKER|$ORG/fleets"
  "api|$ORG/./fleets/f1?q=$FLEET_MARKER|$ORG/fleets/f1"
  "api|$ORG/%66leets/f1?q=$FLEET_MARKER|$ORG/fleets/f1"
  "api|$ORG/fleets/f1/quick-deploy-links?limit=5&q=$FLEET_MARKER|$ORG/fleets/f1/quick-deploy-links"
  "web|/API/V1/ORGANIZATIONS/o1/FLEETS?q=$FLEET_MARKER|/API/V1/ORGANIZATIONS/o1/FLEETS"
  "api|$ORG/configurations?q=$CONF_MARKER|$ORG/configurations"
  "api|$ORG/configurations/?q=$CONF_MARKER&cursor=abc|$ORG/configurations/"
  "api|//api/v1/organizations/o1//configurations?q=$CONF_MARKER|$ORG/configurations"
  "api|$ORG/x/../configurations?q=$CONF_MARKER|$ORG/configurations"
  "api|$ORG/%63onfigurations?q=$CONF_MARKER|$ORG/configurations"
  "web|/API/V1/ORGANIZATIONS/o1/CONFIGURATIONS?q=$CONF_MARKER|/API/V1/ORGANIZATIONS/o1/CONFIGURATIONS"
  "api|$PF?q=$FLOW_MARKER|$PF"
  "api|$PF/|$PF"
  "api|$PF//?x=$FLOW_MARKER|$PF"
  "api|$PF/$FLOW_MARKER|$PF/:slug"
  "api|$PF/$FLOW_MARKER?x=$FLOW_MARKER|$PF/:slug"
  "api|//api/v1/published-flows/$FLOW_MARKER|$PF/:slug"
  "api|/api/v1//published-flows//$FLOW_MARKER|$PF/:slug"
  "api|/api/v1/x/../published-flows/$FLOW_MARKER|$PF/:slug"
  "api|/api/v1/./published-flows/$FLOW_MARKER|$PF/:slug"
  "api|/api/v1/%70ublished-flows/$FLOW_MARKER|$PF/:slug"
  "api|$PF/$FLOW_MARKER/../x|$PF/:slug"
  "api|$PF%2F$FLOW_MARKER|$PF/:slug"
  "api|$PF%252F$FLOW_MARKER|$PF/:slug"
  "api|$PF;$FLOW_MARKER|$PF/:slug"
  "api|$PF%3B$FLOW_MARKER|$PF/:slug"
  "api|$PF%3F$FLOW_MARKER|$PF/:slug"
  "api|$PF%23$FLOW_MARKER|$PF/:slug"
  "api|$PF%253f$FLOW_MARKER|$PF/:slug"
  "web|/API/V1/PUBLISHED-FLOWS/$FLOW_MARKER|$PF/:slug"
)
# A secret's line wins: [upstream|path as sent|its line's path].
WINNING_REQUESTS=(
  "api|$PF/$TF?x=$FLOW_MARKER|/[redacted]"
  "api|$ORG/fleets?q=$TF|/[redacted]"
  "api|$ORG/fleets/f1/quick-deploy/$SECRET?q=$FLEET_MARKER|/api/v1/quick-deploy/[redacted]"
)
# Logged as sent: the lookalikes, a configuration's own paths (the "query
# kept" canary) and an ordinary path.
KEPT_PATHS=(
  "/api/v1/published-flowsx/keep2?y=keep3"
  "$ORG/fleetsx?q=keep4"
  "$ORG/configurations/c1/versions?limit=5"
  "$ORG/configurations/c1?x=keep5"
  "/api/v1/auth/me?x=1"
)
# The configurations list's 5 MiB, a trailing slash or not: [status|bytes|path].
LIST_BODIES=(
  "200|5000000|$ORG/configurations/"
  "200|5000000|$ORG/configurations"
  "413|5300000|$ORG/configurations?q=$CONF_MARKER"
)

start_gateway up
: >"$work/expected-9"
for entry in "${DROPPED_REQUESTS[@]}" "${WINNING_REQUESTS[@]}"; do
  upstream=${entry%%|*}
  rest=${entry#*|}
  send "${rest%%|*}"
  [ "$status $body" = "200 $upstream stand-in" ] || fail "$(shown_public "$(shown "${rest%%|*}")") answered '$status', not the $upstream stand-in's 200"
  printf 'GET %s HTTP/1.1 200\n' "${rest#*|}" >>"$work/expected-9"
done
for path in "${KEPT_PATHS[@]}"; do
  send "$path"
  [ "$status $body" = "200 api stand-in" ] || fail "$path answered '$status', not the API stand-in's 200"
  printf 'GET %s HTTP/1.1 200\n' "$path" >>"$work/expected-9"
done
for entry in "${LIST_BODIES[@]}"; do
  expected=${entry%%|*}
  rest=${entry#*|}
  size=${rest%%|*}
  path=${rest#*|}
  [ -f "$work/body-$size" ] || head -c "$size" /dev/zero | tr '\0' 'a' >"$work/body-$size"
  body_status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$work/body-$size" "http://127.0.0.1:$PORT$path")
  if [ "$body_status" = "$expected" ]; then
    echo "ok: POST ${path%%\?*} with $size bytes answered $expected"
  else
    fail "POST ${path%%\?*} with $size bytes answered $body_status, not $expected"
  fi
  printf 'POST %s HTTP/1.1 %s\n' "${path%%\?*}" "$expected" >>"$work/expected-9"
done
read_logs $(($(grep -c . "$work/expected-9") + 1))
check_lines "fleets, configurations list, published flows, upstreams up" "$work/expected-9"
check_no_marker "fleets, upstreams up" "$FLEET_MARKER"
check_no_marker "configurations list, upstreams up" "$CONF_MARKER"
check_no_marker "published flows, upstreams up" "$FLOW_MARKER"
check_no_canary "fleets, published flows, upstreams up"
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  fail "fleets, published flows, upstreams up: a log line holds an API token (not printed)"
else
  echo "ok: fleets, published flows, upstreams up: no access or error log line holds an API token"
fi

# ---------------------------------------------------------------------------
# 10. The same, the upstreams down: nginx's error log would quote the
# request line, query and all, so the fleets, published-flows and
# configurations list locations log crit only (another case isn't sent: the
# web app's location logs at the image's level, the residue above).
start_gateway down
: >"$work/expected-10"
for entry in "${DROPPED_REQUESTS[@]}" "${WINNING_REQUESTS[@]}"; do
  [ "${entry%%|*}" = api ] || continue
  rest=${entry#*|}
  send "${rest%%|*}"
  [ "$status" = 502 ] || fail "$(shown_public "$(shown "${rest%%|*}")") answered $status with the upstreams down, not 502"
  printf 'GET %s HTTP/1.1 502\n' "${rest#*|}" >>"$work/expected-10"
done
too_large=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data-binary "@$work/body-5300000" \
  "http://127.0.0.1:$PORT$ORG/configurations/?q=$CONF_MARKER")
[ "$too_large" = 413 ] || fail "the configurations list's create over 5 MiB answered $too_large with the upstreams down, not 413"
printf 'POST %s HTTP/1.1 413\n' "$ORG/configurations/" >>"$work/expected-10"
for path in "/api/v1/published-flowsx/keep2?y=keep3" "/api/v1/auth/me?x=1"; do
  send "$path"
  [ "$status" = 502 ] || fail "$path answered $status with the API down, not 502"
  printf 'GET %s HTTP/1.1 502\n' "$path" >>"$work/expected-10"
done
read_logs $(($(grep -c . "$work/expected-10") + 1))
check_lines "fleets, configurations list, published flows, upstreams down" "$work/expected-10"
check_no_marker "fleets, upstreams down" "$FLEET_MARKER"
check_no_marker "configurations list, upstreams down" "$CONF_MARKER"
check_no_marker "published flows, upstreams down" "$FLOW_MARKER"
check_no_canary "fleets, published flows, upstreams down"
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  fail "fleets, published flows, upstreams down: a log line holds an API token (not printed)"
else
  echo "ok: fleets, published flows, upstreams down: no access or error log line holds an API token"
fi
check_failure_logged "the published-flowsx lookalike" "GET /api/v1/published-flowsx/keep2?y=keep3 HTTP/1.1"
check_failure_logged "an ordinary request" "GET /api/v1/auth/me?x=1 HTTP/1.1"

# ---------------------------------------------------------------------------
# 11. gateway.extraRoutes: the chart's rendered snippet, on a fresh
# container with a stand-in for its service.
# [the upstream's reply|the path as sent]: the site's paths, the web app's
# and the API's around them.
EXTRA_REQUESTS=(
  "site|/"
  "site|/?x=1"
  "site|/home/"
  "site|/home/x"
  "site|/home/x?y=1"
  "site|/home/a/b.js"
  "site|//home/x"
  "site|/home//x"
  "site|/%68ome/x"
  "site|/api/../home/x"
  "site|/x/../home/x"
  "web|/homex"
  "web|/HOME/x"
  "web|/login"
  "web|/register"
  "web|/_root.data"
  "web|/forgot-password"
  "web|/robots.txt"
  "web|/assets/a.js"
  "web|/index.html"
  "web|/app"
  "api|/api/v1/auth/me"
  "api|/api/v1/organizations/o1/fleets?q=1"
)
start_gateway up "$work/telflo-fixture"
: >"$work/expected-11"
for entry in "${EXTRA_REQUESTS[@]}"; do
  upstream=${entry%%|*}
  path=${entry#*|}
  send "$path"
  [ "$status $body" = "200 $upstream stand-in" ] || fail "extra routes: $path answered '$status $body', not the $upstream stand-in's 200"
  logged=$path
  [ "$path" = "/api/v1/organizations/o1/fleets?q=1" ] && logged=/api/v1/organizations/o1/fleets
  printf 'GET %s HTTP/1.1 200\n' "$logged" >>"$work/expected-11"
done
# /home: nginx's own 301 to /home/ (an absolute Location: the accepted residue).
location_header=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$PORT/home")
if [[ "$location_header" =~ ^301\ http://[^/]+/home/$ ]]; then
  echo "ok: extra routes: /home is nginx's 301 to /home/"
else
  fail "extra routes: /home answered '$location_header', not nginx's 301 to /home/"
fi
printf 'GET /home HTTP/1.1 301\n' >>"$work/expected-11"
# The access log's rules are the server's: a tf_ token and a quick-deploy
# secret under /home/ reach the site, their lines redacted.
send "/home/x?t=$TF"
[ "$status $body" = "200 site stand-in" ] || fail "extra routes: a /home/ path holding tf_ answered '$status', not the site stand-in's 200"
printf 'GET /[redacted] HTTP/1.1 200\n' >>"$work/expected-11"
send "/home/quick-deploy/$SECRET"
[ "$status $body" = "200 site stand-in" ] || fail "extra routes: a /home/ path holding a quick-deploy secret answered '$status', not the site stand-in's 200"
printf 'GET /api/v1/quick-deploy/[redacted] HTTP/1.1 200\n' >>"$work/expected-11"
read_logs $(($(grep -c . "$work/expected-11") + 1))
check_lines "extra routes, upstreams up" "$work/expected-11"
check_no_canary "extra routes, upstreams up"
if printf '%s\n%s\n' "$access" "$errors" | grep -qF "$TF_CANARY"; then
  fail "extra routes, upstreams up: a log line holds an API token (not printed)"
else
  echo "ok: extra routes, upstreams up: no access or error log line holds an API token"
fi

# The upstreams down: the site's paths 502, its blocks' error log crit and
# worse only (the access log keeps a site path as sent, as any other).
SITE_MARKER="site-path-marker-$$"
start_gateway down "$work/telflo-fixture"
: >"$work/expected-11-down"
for path in "/?q=$SITE_MARKER" "/home/x?q=$SITE_MARKER" "//home/$SITE_MARKER" "/%68ome/$SITE_MARKER" "/api/../home/$SITE_MARKER"; do
  send "$path"
  [ "$status" = 502 ] || fail "extra routes: $path answered $status with the upstreams down, not 502"
  printf 'GET %s HTTP/1.1 502\n' "$path" >>"$work/expected-11-down"
done
send "/api/v1/auth/me?x=1"
[ "$status" = 502 ] || fail "/api/v1/auth/me?x=1 answered $status with the API down, not 502"
printf 'GET /api/v1/auth/me?x=1 HTTP/1.1 502\n' >>"$work/expected-11-down"
read_logs $(($(grep -c . "$work/expected-11-down") + 1))
check_lines "extra routes, upstreams down" "$work/expected-11-down"
if printf '%s\n' "$errors" | grep -qF "$SITE_MARKER"; then
  fail "extra routes, upstreams down: $(printf '%s\n' "$errors" | grep -cF "$SITE_MARKER") error log line(s) hold a site path's marker"
else
  echo "ok: extra routes, upstreams down: no error log line holds a site path's marker"
fi
check_failure_logged "extra routes: an ordinary request" "GET /api/v1/auth/me?x=1 HTTP/1.1"

# Without the include's file nginx doesn't start: the include names an
# exact file, never a pattern.
create_gateway down none
docker start "$CONTAINER" >/dev/null 2>&1
running=true
for attempt in $(seq 1 100); do
  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
  [ "$running" = false ] && break
  sleep 0.1
done
docker logs "$CONTAINER" >"$work/stdout" 2>"$work/stderr"
if [ "$running" = false ] && grep -F '[emerg]' "$work/stderr" | grep -qF '/etc/nginx/telflo/extra-routes.conf'; then
  echo "ok: extra routes: without /etc/nginx/telflo/extra-routes.conf nginx stops ([emerg])"
else
  fail "extra routes: without /etc/nginx/telflo/extra-routes.conf nginx still ran (running '$running')"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all gateway log checks passed"
