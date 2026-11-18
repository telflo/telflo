#!/usr/bin/env bash
# Verifies scripts/wait-for-http.mjs: it succeeds once a URL answers 200, and
# gives up after exactly its bound of attempts against a closed port or a
# server that never answers 200, then prints the compose service's logs when
# given one. A local server counts the attempts; a stand-in `docker` on PATH
# records the logs command, so no real compose project is touched.
set -uo pipefail
cd "$(dirname "$0")/.."
FAILURES=0

fixture=$(mktemp -d)
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  rm -rf "$fixture"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Starts a local server that answers `status` until it has been asked
# `until` times, then 200 (`until` 0: always `status`). It writes its port to
# $fixture/port and appends a line to $fixture/hits for each request.
start_server() {
  local status="$1" until="$2"
  stop_server
  rm -f "$fixture/port" "$fixture/hits"
  touch "$fixture/hits"
  node -e '
    const { createServer } = require("node:http");
    const { appendFileSync, writeFileSync } = require("node:fs");
    const [status, until, dir] = process.argv.slice(1);
    let hits = 0;
    const server = createServer((request, response) => {
      hits += 1;
      appendFileSync(`${dir}/hits`, "hit\n");
      response.writeHead(Number(until) > 0 && hits >= Number(until) ? 200 : Number(status));
      response.end("ok");
    });
    server.listen(0, "127.0.0.1", () => writeFileSync(`${dir}/port`, String(server.address().port)));
  ' "$status" "$until" "$fixture" &
  server_pid=$!
  for _ in $(seq 1 100); do [ -s "$fixture/port" ] && break; sleep 0.05; done
  [ -s "$fixture/port" ] || { echo "the test server didn't start"; exit 1; }
  port=$(cat "$fixture/port")
}

stop_server() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null
    wait "$server_pid" 2>/dev/null
    server_pid=""
  fi
}

hits() { wc -l < "$fixture/hits" | tr -d ' '; }

# 1. A live URL: one attempt, exit 0.
start_server 200 0
if ! output=$(node scripts/wait-for-http.mjs "http://127.0.0.1:$port/health" 5 2>&1); then
  fail "a URL that answers 200 should pass ($output)"
fi
[ "$(hits)" = "1" ] || fail "a URL that answers 200 should be asked once, was asked $(hits) times"

# 2. A server that answers 200 on its third request: exit 0 after three.
start_server 503 3
if ! output=$(node scripts/wait-for-http.mjs "http://127.0.0.1:$port/health" 5 2>&1); then
  fail "a URL that answers 200 on the third attempt should pass ($output)"
fi
[ "$(hits)" = "3" ] || fail "it should stop asking at the first 200, asked $(hits) times"

# 3. A server that never answers 200: exactly the bound, then exit 1, naming the status.
start_server 503 0
if output=$(node scripts/wait-for-http.mjs "http://127.0.0.1:$port/health" 3 2>&1); then
  fail "a URL that never answers 200 should fail"
fi
[ "$(hits)" = "3" ] || fail "the bound is 3 attempts, it made $(hits)"
case "$output" in *"after 3 attempts (the last: HTTP 503)"*) ;; *) fail "the message should name the bound and the status: $output" ;; esac

# 4. A closed port: exit 1 after the bound, naming the refusal.
stop_server
if output=$(node scripts/wait-for-http.mjs "http://127.0.0.1:$port/health" 2 2>&1); then
  fail "a closed port should fail"
fi
case "$output" in *"after 2 attempts (the last: ECONNREFUSED)"*) ;; *) fail "the message should name the refusal: $output" ;; esac

# 5. Given a compose file and a service, it prints their logs when it gives up.
mkdir -p "$fixture/bin"
cat > "$fixture/bin/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" > "$fixture/docker-args"
echo "a log line from the service"
EOF
chmod +x "$fixture/bin/docker"
if output=$(PATH="$fixture/bin:$PATH" node scripts/wait-for-http.mjs "http://127.0.0.1:$port/health" 1 ./compose.yml opamp-server 2>&1); then
  fail "a closed port should fail with a compose service too"
fi
[ "$(cat "$fixture/docker-args" 2>/dev/null)" = "compose -f ./compose.yml logs --no-color --tail 50 opamp-server" ] ||
  fail "it should ask compose for the service's last 50 log lines, ran: $(cat "$fixture/docker-args" 2>/dev/null)"
case "$output" in *"a log line from the service"*) ;; *) fail "it should print the logs: $output" ;; esac

# 6. Usage: no URL, a bound that isn't a positive integer, a file without a service.
for args in "" "http://127.0.0.1:1" "http://127.0.0.1:1 0" "http://127.0.0.1:1 1.5" "http://127.0.0.1:1 2 ./compose.yml"; do
  # shellcheck disable=SC2086
  node scripts/wait-for-http.mjs $args >/dev/null 2>&1
  [ $? -eq 2 ] || fail "'$args' should be a usage error (exit 2)"
done

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES wait-for-http check(s) failed"
  exit 1
fi
echo "wait-for-http: all checks passed"
