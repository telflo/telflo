# The site's values, the mail's TLS, login and CA, and gateway.extraRoutes'
# value (D36-1 decisions 24, 27, 30 and 39; Preflight rulings 15 and 17).
# With every new value at its default, the rendering differs from D33-1's
# only by the new env lines (api.sh and web.sh list them exactly). Sourced
# by tests/render-tests.sh, which defines every helper used here; api.sh
# defines SITE_ENV and the API's paths.

WEB_SITE_C="Deployment/telflo-web.spec.template.spec.containers[web]"
SAAS="$(listing saas)"

# --- the site ------------------------------------------------------------------------
oss_defaults_same() { profile_ok default && profile_ok oss-defaults && cmp -s "$tmp/p/default.yaml" "$tmp/p/oss-defaults.yaml"; }
run_case "site: the oss-defaults profile (the site, the mail's new values and extraRoutes written out at their defaults) renders exactly as the default one" oss_defaults_same

# site_values <listing> <container path> <the eleven values, one per variable in SITE_ENV's order>
site_values() {
  local l="$1" c="$2" name; shift 2
  for name in $SITE_ENV; do
    eq "$l" "$c.env[$name].value" "\"$1\"" || return 1
    shift
  done
}
site_defaults() {
  local c
  for c in "$API_C" "$WEB_SITE_C"; do
    site_values "$1" "$c" invite-only false false false false false "https://docs.telflo.com/" "" "" "" "" || return 1
  done
}
for p in default oss-defaults; do
  run_case "site: the open source's defaults on the API and the web app ($p)" site_defaults "$(listing "$p")"
done
site_saas() {
  local c
  for c in "$API_C" "$WEB_SITE_C"; do
    site_values "$SAAS" "$c" open true true true true true "https://docs.example.com/telflo/" 2026-01-01 /home/terms-of-service \
      /home/privacy-policy "https://telflo.example.com/home/cookie-policy" || return 1
  done
  eq "$SAAS" "$API_C.env[TELFLO_SALES_INQUIRY_TO].value" '"sales@telflo.example.com"'
}
run_case "site: the saas profile's values on both pods, and its sales address on the API" site_saas
site_same_on_both() { # <listing>: the eleven, in order, with the same values on both pods
  local name
  for name in $SITE_ENV; do
    [ "$(value "$1" "$API_C.env[$name].value")" = "$(value "$1" "$WEB_SITE_C.env[$name].value")" ] || return 1
    [ -n "$(value "$1" "$API_C.env[$name].value")" ] || return 1
  done
}
each_profile "site: the API and the web app read the same eleven values" site_same_on_both
site_literal() { # a $(NAME) in a URL can't read another variable
  next_file
  render_flat "$f" "${D[@]}" --set-string 'site.docsUrl=/docs$(TELFLO_API_PASSWORD)' || return 1
  eq "$f" "$API_C.env[TELFLO_DOCS_URL].value" '"/docs$$(TELFLO_API_PASSWORD)"' &&
    eq "$f" "$WEB_SITE_C.env[TELFLO_DOCS_URL].value" '"/docs$$(TELFLO_API_PASSWORD)"'
}
run_case "site: a \$(NAME) in a URL is escaped (\$\$) on both pods" site_literal
site_docs_hidden() {
  next_file
  render_flat "$f" "${D[@]}" --set-string 'site.docsUrl=' || return 1
  eq "$f" "$API_C.env[TELFLO_DOCS_URL].value" '""' && eq "$f" "$WEB_SITE_C.env[TELFLO_DOCS_URL].value" '""'
}
run_case "site: an empty docsUrl renders as empty (the docs links hidden), not left out" site_docs_hidden

M_PLAYGROUND="site.playground needs site.anonymousValidate and site.publicFlows true: the playground uses both"
run_case "guard: site.playground alone refused" refused "$M_PLAYGROUND" "" "${D[@]}" --set site.playground=true
run_case "guard: site.playground without publicFlows refused" refused "$M_PLAYGROUND" "" "${D[@]}" --set site.playground=true --set site.anonymousValidate=true
run_case "guard: site.playground without anonymousValidate refused" refused "$M_PLAYGROUND" "" "${D[@]}" --set site.playground=true --set site.publicFlows=true
playground_ok() { renders "${D[@]}" --set site.playground=true --set site.anonymousValidate=true --set site.publicFlows=true; }
run_case "guard: site.playground with both renders" playground_ok
run_case "guard: site.salesInquiry without api.salesInquiryTo refused" refused \
  "api.salesInquiryTo is required while site.salesInquiry is true: where the inquiries go" "" "${D[@]}" --set site.salesInquiry=true
M_TERMS_URLS="site.terms.version needs site.terms.termsUrl and site.terms.privacyUrl: what is accepted must be readable"
run_case "guard: a Terms version without its URLs refused" refused "$M_TERMS_URLS" "" "${D[@]}" --set-string site.terms.version=2026-01-01
run_case "guard: a Terms version without the privacy URL refused" refused "$M_TERMS_URLS" "" \
  "${D[@]}" --set-string site.terms.version=2026-01-01 --set-string site.terms.termsUrl=/terms
run_case "guard: a Terms version of another form refused, not quoted" refused \
  "site.terms.version must be 1 to 32 letters, digits, dots, underscores and hyphens" "cnryver" \
  "${D[@]}" --set-string 'site.terms.version=2026 cnryver' --set-string site.terms.termsUrl=/t --set-string site.terms.privacyUrl=/p
M_URL_RULE="must be an https URL (a host, an optional port and path, no user name or password) or a path starting with a single /, of URL characters only"
for key in docsUrl terms.termsUrl terms.privacyUrl terms.cookiePolicyUrl; do
  run_case "guard: site.$key holding a user and password refused, not quoted" refused "site.$key $M_URL_RULE" "cnrypw" \
    "${D[@]}" --set-string "site.$key=https://cnryuser:cnrypw@example.com/x"
done
run_case "guard: site.docsUrl over plain http refused" refused "site.docsUrl $M_URL_RULE" "" "${D[@]}" --set-string 'site.docsUrl=http://docs.example.com/'
run_case "guard: site.terms.termsUrl another origin's // path refused, not quoted" refused "site.terms.termsUrl $M_URL_RULE" "cnryhost" \
  "${D[@]}" --set-string 'site.terms.termsUrl=//cnryhost.example.com/terms'
run_case "guard: site.terms.privacyUrl with a space refused, not quoted" refused "site.terms.privacyUrl $M_URL_RULE" "cnrysp" \
  "${D[@]}" --set-string 'site.terms.privacyUrl=/privacy cnrysp'
site_urls_ok() {
  renders "${D[@]}" --set-string 'site.docsUrl=https://docs.example.com:8443/v2/?lang=en#top' &&
    renders "${D[@]}" --set-string 'site.terms.cookiePolicyUrl=/' &&
    renders "${D[@]}" --set-string site.terms.version=v1.2_x-3 --set-string site.terms.termsUrl=/home/terms --set-string 'site.terms.privacyUrl=https://legal.example.com/privacy'
}
run_case "guard: an https URL with a port, path, query and fragment, a lone /, and a Terms version with its URLs render" site_urls_ok
schema_site() {
  schema_refused /site/registration "value must be one of" "${D[@]}" --set-string site.registration=public &&
    schema_refused /site/playground "got string, want boolean" "${D[@]}" --set-string site.playground=yes &&
    schema_refused /site "additional properties 'cnryKey' not allowed" "${D[@]}" --set site.cnryKey=1 &&
    schema_refused /site/terms "additional properties 'cnryKey' not allowed" "${D[@]}" --set site.terms.cnryKey=1 &&
    schema_refused /site/terms/version "maxLength: got 33, want 32" "${D[@]}" --set-string "site.terms.version=$(printf 'a%.0s' $(seq 1 33))"
}
run_case "schema: site.registration's modes, booleans, closed objects, a version of at most 32 characters" schema_site
registration_modes() { renders "${D[@]}" --set-string site.registration=open && renders "${D[@]}" --set-string site.registration=closed; }
run_case "site.registration open and closed render" registration_modes
# A null value (Helm drops it before the schema sees it) or one of another
# type is refused by the guards, never rendered as Go's "<nil>" (Ruling 347).
M_SITE_STR() { printf '%s must be a string, not null or another type' "$1"; }
M_SITE_BOOL() { printf '%s must be true or false, not null or another type' "$1"; }
for key in registration docsUrl terms.version terms.termsUrl terms.privacyUrl terms.cookiePolicyUrl; do
  run_case "guard: a null site.$key refused" refused "$(M_SITE_STR "site.$key")" "" "${D[@]}" --set "site.$key=null"
done
for key in playground anonymousValidate publicFlows salesInquiry emailNotifications; do
  run_case "guard: a null site.$key refused" refused "$(M_SITE_BOOL "site.$key")" "" "${D[@]}" --set "site.$key=null"
done
run_case "guard: a null site.terms refused" refused "$(M_SITE_STR site.terms.cookiePolicyUrl)" "" "${D[@]}" --set site.terms=null
run_case "guard: a null site refused" refused "$(M_SITE_BOOL site.playground)" "" "${D[@]}" --set site=null
run_case "guard: a site.docsUrl of another type refused without the schema" refused "$(M_SITE_STR site.docsUrl)" "" \
  "${D[@]}" --skip-schema-validation --set site.docsUrl=1
run_case "guard: a site.playground of another type refused without the schema" refused "$(M_SITE_BOOL site.playground)" "" \
  "${D[@]}" --skip-schema-validation --set-string site.playground=true
# Ruling 351: site and site.terms are maps before any of their fields is read.
run_case "guard: a site.terms that isn't a map refused without the schema" refused \
  "site.terms must be a map of version, termsUrl, privacyUrl and cookiePolicyUrl" "" "${D[@]}" --skip-schema-validation --set-string site.terms=x
run_case "guard: a site that isn't a map refused without the schema" refused \
  "site must be a map of the site's values" "" "${D[@]}" --skip-schema-validation --set-string site=x
no_nil() { ! grep -qF '<nil>' "$1.yaml"; }
each_profile "site: nothing renders Go's <nil>" no_nil

# --- the mail's TLS, login and CA (decisions 30 and 39) ----------------------------------
SMTP_CA_DIR=/etc/telflo/smtp-ca
mail_saas() {
  eq "$SAAS" "$API_C.env[TELFLO_SMTP_TLS].value" '"implicit"' && eq "$SAAS" "$API_C.env[TELFLO_SMTP_PORT].value" '"465"' &&
    eq "$SAAS" "$API_C.env[TELFLO_SMTP_USERNAME].valueFrom.secretKeyRef.name" '"telflo-mail"' &&
    eq "$SAAS" "$API_C.env[TELFLO_SMTP_USERNAME].valueFrom.secretKeyRef.key" '"smtp-username"' &&
    eq "$SAAS" "$API_C.env[TELFLO_SMTP_PASSWORD].valueFrom.secretKeyRef.name" '"telflo-mail"' &&
    eq "$SAAS" "$API_C.env[TELFLO_SMTP_PASSWORD].valueFrom.secretKeyRef.key" '"smtp-password"' &&
    no_path "$SAAS" "$API_C.env[TELFLO_SMTP_USERNAME].value" && no_path "$SAAS" "$API_C.env[TELFLO_SMTP_PASSWORD].value" &&
    no_path "$SAAS" "$API_C.env[TELFLO_SMTP_PASSWORD].valueFrom.secretKeyRef.optional" &&
    eq "$SAAS" "$API_C.env[TELFLO_SMTP_CA_FILE].value" "\"$SMTP_CA_DIR/ca.crt\""
}
run_case "mail, saas: TELFLO_SMTP_TLS implicit; the login from existingSecrets.mail's smtp-username and smtp-password (secretKeyRefs, required); the CA file's path" mail_saas
mail_ca_mount() {
  eq "$SAAS" "$API_C.volumeMounts[smtp-ca].mountPath" "\"$SMTP_CA_DIR\"" && eq "$SAAS" "$API_C.volumeMounts[smtp-ca].readOnly" true &&
    eq "$SAAS" "$API_POD.volumes[smtp-ca].secret.secretName" '"example-smtp-ca"' &&
    eq "$SAAS" "$API_POD.volumes[smtp-ca].secret.items[0].key" '"ca.crt"' && eq "$SAAS" "$API_POD.volumes[smtp-ca].secret.items[0].path" '"ca.crt"' &&
    no_path "$SAAS" "$API_POD.volumes[smtp-ca].secret.items[1]" && eq "$SAAS" "$API_POD.volumes[smtp-ca].secret.defaultMode" 292 &&
    no_path "$SAAS" "$API_M.volumeMounts" &&
    ! grep -F "Deployment/telflo-web." "$SAAS" | grep -q 'smtp-ca'
}
run_case "mail, saas: api.mail.smtp.caSecret's ca.crt alone, mounted read-only (0444) at $SMTP_CA_DIR in the API's container only" mail_ca_mount
mail_none_by_default() { # <listing>: no login, no CA (every profile but saas)
  [ "$(basename "$1")" = saas ] && return 0
  no_path "$1" "$API_C.env[TELFLO_SMTP_USERNAME]" && no_path "$1" "$API_C.env[TELFLO_SMTP_PASSWORD]" &&
    no_path "$1" "$API_C.env[TELFLO_SMTP_CA_FILE]" && no_path "$1" "$API_C.volumeMounts[smtp-ca]" && no_path "$1" "$API_POD.volumes[smtp-ca]"
}
each_profile "mail: no login and no CA unless asked (every profile but saas)" mail_none_by_default
mail_sendgrid_ignores_smtp() { # with sendgrid, the SMTP login and CA render nothing
  next_file
  render_flat "$f" -f "$PROFILES_DIR/saas.yaml" --set-string api.mail.transport=sendgrid || return 1
  no_path "$f" "$API_C.env[TELFLO_SMTP_TLS]" && no_path "$f" "$API_C.env[TELFLO_SMTP_USERNAME]" &&
    no_path "$f" "$API_C.env[TELFLO_SMTP_CA_FILE]" && no_path "$f" "$API_POD.volumes[smtp-ca]" &&
    eq "$f" "$API_C.env[TELFLO_SENDGRID_API_KEY].valueFrom.secretKeyRef.key" '"sendgrid-api-key"'
}
run_case "mail: with sendgrid, api.mail.smtp's tls, auth and caSecret render nothing" mail_sendgrid_ignores_smtp
mail_tls_modes() {
  local mode
  for mode in starttls implicit none; do
    next_file
    render_flat "$f" "${D[@]}" --set-string "api.mail.smtp.tls=$mode" || return 1
    eq "$f" "$API_C.env[TELFLO_SMTP_TLS].value" "\"$mode\"" || return 1
  done
}
run_case "mail: api.mail.smtp.tls's three modes become TELFLO_SMTP_TLS" mail_tls_modes
run_case "schema: api.mail.smtp.tls another mode refused" schema_refused /api/mail/smtp/tls "value must be one of" "${D[@]}" --set-string api.mail.smtp.tls=ssl
run_case "guard: api.mail.smtp.auth without existingSecrets.mail refused" refused "$(M_REQ existingSecrets.mail)" "" \
  "${D[@]}" --set api.mail.smtp.auth=true --set-string existingSecrets.mail=
run_case "guard: api.mail.smtp.caSecret holding hex refused, not quoted" refused "$(M_NAME api.mail.smtp.caSecret)" "$HEX32" \
  "${D[@]}" --set-string "api.mail.smtp.caSecret=$HEX32"
M_HOST="api.mail.smtp.host must be a host name or address (letters, digits, . and -, or an IPv6 address without brackets), with no user name, password or port"
mail_host_ipv6() {
  renders "${D[@]}" --set-string 'api.mail.smtp.host=2001:db8::25' && renders "${D[@]}" --set-string 'api.mail.smtp.host=::1' &&
    renders "${D[@]}" --set-string 'api.mail.smtp.host=192.0.2.25'
}
run_case "guard: api.mail.smtp.host takes an IPv6 address without brackets, and an IPv4 one" mail_host_ipv6
run_case "guard: api.mail.smtp.host with a port refused (host:port is not an IPv6 address)" refused "$M_HOST" "" "${D[@]}" --set-string 'api.mail.smtp.host=cafe:25'
run_case "guard: api.mail.smtp.host in brackets refused" refused "$M_HOST" "" "${D[@]}" --set-string 'api.mail.smtp.host=[2001:db8::25]'

# --- gateway.extraRoutes: the value and its schema (Task 6b renders it) --------------------
# routes <file> <one route's YAML lines, already indented under a list item>
routes() { local file="$1"; shift; { printf 'gateway:\n  extraRoutes:\n    - '; printf '%s\n      ' "$@"; printf '\n'; } >"$file"; }
extra_routes_ok() {
  routes "$tmp/routes-ok.yaml" 'path: /' 'match: exact' 'service: telflo-site' 'port: 8080'
  renders "${D[@]}" -f "$tmp/routes-ok.yaml" && renders "${D[@]}" --set 'gateway.extraRoutes=null'
}
run_case "gateway.extraRoutes: empty by default; a well-formed route is accepted" extra_routes_ok
extra_routes_schema() {
  routes "$tmp/r1.yaml" 'path: /home/' 'match: prefix' 'service: telflo-site' 'port: 8080' 'cnryKey: 1'
  routes "$tmp/r2.yaml" 'path: "/home x"' 'match: prefix' 'service: telflo-site' 'port: 8080'
  routes "$tmp/r3.yaml" 'path: /home/' 'match: regex' 'service: telflo-site' 'port: 8080'
  routes "$tmp/r4.yaml" 'path: /home/' 'match: prefix' 'service: Telflo_Site' 'port: 8080'
  routes "$tmp/r5.yaml" 'path: /home/' 'match: prefix' 'service: telflo-site' 'port: 0'
  routes "$tmp/r6.yaml" 'path: /home/' 'match: prefix' 'service: telflo-site'
  routes "$tmp/r7.yaml" 'path: home/' 'match: prefix' 'service: telflo-site' 'port: 8080'
  schema_refused /gateway/extraRoutes/0 "additional properties 'cnryKey' not allowed" "${D[@]}" -f "$tmp/r1.yaml" &&
    schema_refused /gateway/extraRoutes/0/path "does not match pattern" "${D[@]}" -f "$tmp/r2.yaml" &&
    schema_refused /gateway/extraRoutes/0/match "value must be one of" "${D[@]}" -f "$tmp/r3.yaml" &&
    schema_refused /gateway/extraRoutes/0/service "does not match pattern" "${D[@]}" -f "$tmp/r4.yaml" &&
    schema_refused /gateway/extraRoutes/0/port "minimum" "${D[@]}" -f "$tmp/r5.yaml" &&
    schema_refused /gateway/extraRoutes/0 "missing property 'port'" "${D[@]}" -f "$tmp/r6.yaml" &&
    schema_refused /gateway/extraRoutes/0/path "does not match pattern" "${D[@]}" -f "$tmp/r7.yaml"
}
run_case "schema: gateway.extraRoutes' items closed, all four keys required; path, match, service and port checked" extra_routes_schema
