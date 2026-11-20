{{/*
Shared snippets. A file whose name starts with "_" renders nothing itself.

Every template begins with {{ include "telflo.guards" . }}, so
rendering any one alone (helm template --show-only) is refused the same way.
*/}}

{{/*
The names. Fixed, not taken from the release: the gateway's default.conf
names telflo-api and telflo-web, the API reaches the internal services and
the opamp-server by these names, and the opamp-server chart's
management.from selects the API's pods by their fixed labels. So one
release per namespace (the guards refuse a second).
*/}}
{{- define "telflo.name" -}}telflo{{- end }}
{{- define "telflo.apiName" -}}telflo-api{{- end }}
{{- define "telflo.webName" -}}telflo-web{{- end }}
{{- define "telflo.gatewayName" -}}telflo-gateway{{- end }}
{{- define "telflo.postgresName" -}}telflo-postgres{{- end }}
{{- define "telflo.validatorName" -}}otelcol-validator{{- end }}
{{- define "telflo.testerName" -}}otelcol-testing{{- end }}
{{- define "telflo.evaluatorName" -}}ottl-evaluator{{- end }}
{{/* The ConfigMap holding the platform's bootstrap (telflo-bootstrap.sql, telflo-initdb.sh). */}}
{{- define "telflo.postgresBootstrapName" -}}telflo-postgres-bootstrap{{- end }}
{{/* The headless Service the StatefulSet names its pod by. */}}
{{- define "telflo.postgresHeadlessName" -}}telflo-postgres-headless{{- end }}

{{/*
The opamp-server chart's objects, by its fixed fullnameOverride
(telflo-opamp-server; a guard holds it): its bootstrap ConfigMap (initdb.sh
and bootstrap.sql), always rendered, which the platform's Postgres mounts.
*/}}
{{- define "telflo.opampFullname" -}}telflo-opamp-server{{- end }}
{{- define "telflo.opampBootstrapName" -}}telflo-opamp-server-bootstrap{{- end }}

{{/* The URLs the API calls, inside the cluster. */}}
{{- define "telflo.apiInternalUrl" -}}http://telflo-api:8080{{- end }}
{{- define "telflo.opampManagementUrl" -}}http://telflo-opamp-server-management:51235{{- end }}
{{- define "telflo.validatorUrl" -}}http://otelcol-validator:8001{{- end }}
{{- define "telflo.testerUrl" -}}http://otelcol-testing:8002{{- end }}
{{- define "telflo.evaluatorUrl" -}}http://ottl-evaluator:8003{{- end }}

{{/*
A database URL in the platform's Postgres, composed with Kubernetes' $(VAR)
expansion of the password variable listed before it in the same container:
no password is ever rendered. Call with (list <role> <password variable>
<database>): for example (list "telflo_platform" "TELFLO_API_PASSWORD" "telflo_platform")
gives postgresql://telflo_platform:$(TELFLO_API_PASSWORD)@telflo-postgres:5432/telflo_platform.
The passwords are URL-safe (create-secrets.sh makes hex, and the containers
check with telflo.urlSafeExec before they start).
*/}}
{{- define "telflo.databaseUrl" -}}
{{- printf "postgresql://%s:$(%s)@%s:5432/%s" (index . 0) (index . 1) (include "telflo.postgresName" .) (index . 2) }}
{{- end }}

{{/*
Labels on every object. Call with (dict "ctx" . "component" "api"). The
components: api, web, gateway, otelcol-validator, otelcol-testing,
ottl-evaluator, postgres.
*/}}
{{- define "telflo.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service | quote }}
app.kubernetes.io/part-of: "telflo"
{{ include "telflo.selectorLabels" . }}
{{- end }}

{{/*
The labels a workload selects its pods by, and a Service or a NetworkPolicy
routes by. Never change them on an installed release: a selector is
immutable. The API's pods carry app.kubernetes.io/name telflo and
app.kubernetes.io/component api, exactly what opamp-server's
networkPolicy.management.from selects.
*/}}
{{- define "telflo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "telflo.name" .ctx | quote }}
app.kubernetes.io/instance: {{ .ctx.Release.Name | quote }}
app.kubernetes.io/component: {{ .component | quote }}
{{- end }}

{{/*
A component's image reference: <registry>/<repository>:<tag>[@<digest>],
the registry the component's own or image.registry, the tag its own or the
chart's appVersion. Call with (list . "api").
*/}}
{{- define "telflo.image" -}}
{{- $ := index . 0 }}
{{- $image := (index $.Values (index . 1)).image }}
{{- $registry := default $.Values.image.registry $image.registry }}
{{- $tag := default $.Chart.AppVersion $image.tag }}
{{- if $image.digest }}
{{- printf "%s/%s:%s@%s" $registry $image.repository $tag $image.digest }}
{{- else }}
{{- printf "%s/%s:%s" $registry $image.repository $tag }}
{{- end }}
{{- end }}

{{/* A component's pull policy: its own, or image.pullPolicy. Call with (list . "api"). */}}
{{- define "telflo.pullPolicy" -}}
{{- $ := index . 0 }}
{{- default $.Values.image.pullPolicy (index $.Values (index . 1)).image.pullPolicy }}
{{- end }}

{{/*
What every platform pod's spec holds: no service-account token (the
validator's image bakes a fake one at that path, and no pod needs the
API server), no service links (no variables naming every Service), and
global.imagePullSecrets. Pre-indented by the caller: nindent 6 under a
pod template's spec.
*/}}
{{- define "telflo.podBasics" -}}
automountServiceAccountToken: false
enableServiceLinks: false
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
A component's scheduling values: nodeSelector, tolerations, affinity, each
only when set. Call with (list . "api"); the caller indents it as pod spec
keys.
*/}}
{{- define "telflo.scheduling" -}}
{{- $c := index (index . 0).Values (index . 1) }}
{{- with $c.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $c.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $c.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
A pod's security context (the restricted Pod Security Standard's): non-root
as the image's own numeric user and group, the RuntimeDefault seccomp
profile. Call with (dict "uid" 1000 "gid" 1000), adding "fsGroup" 10001 for
a pod whose volumes the user must own or read (a projected secret, an
emptyDir home), and "sysctls" (a list of {name, value}) for the gateway's
net.ipv4.ip_unprivileged_port_start. The images' users: api and web 1000,
the gateway (nginx) 101, the validator and the tester 10001, the evaluator
65532, Postgres 999.
*/}}
{{- define "telflo.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ int .uid }}
runAsGroup: {{ int .gid }}
{{- if hasKey . "fsGroup" }}
fsGroup: {{ int .fsGroup }}
{{- end }}
seccompProfile:
  type: RuntimeDefault
{{- with .sysctls }}
sysctls:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
A container's security context: non-root, a read-only root filesystem (a
service writes only to emptyDirs), every capability dropped, no privilege
gained through exec, RuntimeDefault seccomp. Call with (dict "uid" 1000
"gid" 1000).
*/}}
{{- define "telflo.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: {{ int .uid }}
runAsGroup: {{ int .gid }}
capabilities:
  drop: ["ALL"]
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{/*
An environment variable read from a Secret: a list item, for under env:.
Call with (dict "name" "TELFLO_ACCESS_TOKEN_SECRET" "secret" <a Secret's
name> "key" "access-token-secret"), adding "optional" true for a key the
Secret may leave out. The Secret's name comes from
telflo.secretName or telflo.opampSecretName, which check
it; the value never reaches the rendered manifest.
*/}}
{{- define "telflo.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret | quote }}
      key: {{ .key | quote }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

{{/*
Kubernetes expands $(NAME) in a container's env values (and in its command
and args) from the variables listed before it, and reads "$$" as one "$".
So every plain env value taken from values goes through these: each "$"
doubled, the container sees the value exactly as given, and no value can
name another variable (a secret's, say). envEscape is the bare text,
envLiteral the quoted value.
*/}}
{{- define "telflo.envEscape" -}}
{{- toString . | replace "$" "$$" }}
{{- end }}
{{- define "telflo.envLiteral" -}}
{{- include "telflo.envEscape" . | quote }}
{{- end }}

{{/*
The site's variables, the same eleven on the API and the web app, from
site.* (every one rendered, so both pods always agree, an empty value
included). Each value is literal (envLiteral). The guards refuse a value of
another type (a null one included); even so, nothing here renders Go's
"<nil>": a missing string is "", a missing boolean "false". Pre-indented by
the caller: nindent 12 under a container's env.
*/}}
{{- define "telflo.siteEnv" -}}
{{- $site := ternary .Values.site dict (kindIs "map" .Values.site) -}}
{{- $terms := ternary $site.terms dict (kindIs "map" $site.terms) -}}
- name: TELFLO_REGISTRATION
  value: {{ include "telflo.siteString" $site.registration }}
- name: TELFLO_PLAYGROUND
  value: {{ include "telflo.siteBool" $site.playground }}
- name: TELFLO_ANONYMOUS_VALIDATE
  value: {{ include "telflo.siteBool" $site.anonymousValidate }}
- name: TELFLO_PUBLIC_FLOWS
  value: {{ include "telflo.siteBool" $site.publicFlows }}
- name: TELFLO_SALES_INQUIRY
  value: {{ include "telflo.siteBool" $site.salesInquiry }}
- name: TELFLO_EMAIL_NOTIFICATIONS
  value: {{ include "telflo.siteBool" $site.emailNotifications }}
- name: TELFLO_DOCS_URL
  value: {{ include "telflo.siteString" $site.docsUrl }}
- name: TELFLO_TERMS_VERSION
  value: {{ include "telflo.siteString" $terms.version }}
- name: TELFLO_TERMS_URL
  value: {{ include "telflo.siteString" $terms.termsUrl }}
- name: TELFLO_PRIVACY_URL
  value: {{ include "telflo.siteString" $terms.privacyUrl }}
- name: TELFLO_COOKIE_POLICY_URL
  value: {{ include "telflo.siteString" $terms.cookiePolicyUrl }}
{{- end }}
{{- define "telflo.siteString" -}}
{{- include "telflo.envLiteral" (ternary . "" (kindIs "string" .)) }}
{{- end }}
{{- define "telflo.siteBool" -}}
{{- ternary "true" "false" (and (kindIs "bool" .) .) | quote }}
{{- end }}

{{/* Where the API mounts api.mail.smtp.caSecret's ca.crt (TELFLO_SMTP_CA_FILE). */}}
{{- define "telflo.smtpCaDir" -}}/etc/telflo/smtp-ca{{- end }}

{{/*
A container's start through sh, checking first that each named variable
(a password the chart puts in a database URL, or Postgres's) is set,
non-empty and URL-safe: a password with another character would make the
URL fail to parse, and Node's URL error quotes the whole URL, password and
all. Only then does it exec the command; otherwise it writes the fixed
message to stderr and exits 1. Call with (dict "vars" (list "A" "B") "exec"
"docker-entrypoint.sh postgres" "message" "..."): the message is fixed
words (no quote, $, backquote or backslash: the chart refuses one), the
variables' names upper-case. Renders the script, the command's third item
(after "sh" and "-c"). It holds no "$(" so Kubernetes expands nothing in it.
*/}}
{{- define "telflo.urlSafeFunction" -}}
url_safe() { case "$1" in "" | *[!A-Za-z0-9._~-]*) return 1 ;; esac; }
{{- end }}
{{- define "telflo.urlSafeExec" -}}
{{- if regexMatch "[\"'$`\\\\]" .message }}{{ fail "telflo.urlSafeExec: the message must hold no quote, $, backquote or backslash" }}{{ end }}
{{- if regexMatch "[\"'$`\\\\\n]" .exec }}{{ fail "telflo.urlSafeExec: the command must hold no quote, $, backquote, backslash or newline" }}{{ end }}
{{- $checks := list }}
{{- range .vars }}
{{- if not (regexMatch "^[A-Z_][A-Z0-9_]*$" .) }}{{ fail "telflo.urlSafeExec: a variable's name must be upper-case letters, digits and _" }}{{ end }}
{{- $checks = append $checks (printf "url_safe \"${%s-}\"" .) }}
{{- end }}
{{- include "telflo.urlSafeFunction" . }}
if {{ join " && " $checks }}; then
  exec {{ .exec }}
fi
echo "{{ .message }}" >&2
exit 1
{{- end }}

{{/*
A Secret's name taken from values, checked: required, a DNS-1123 name of
at most 63 characters (lower-case letters, digits, - and ., a letter or
digit at each end), and not shaped like a generated value (no part between
- or . of 16 or more characters holding a digit, such as hex). A refusal names the value's path and never quotes the value (a
secret pasted where its name belongs must not reach a terminal or a log).
Call with (list <value> <its path>). Returns the name.
*/}}
{{- define "telflo.checkedSecretName" -}}
{{- $name := index . 0 }}
{{- $path := index . 1 }}
{{- if or (kindIs "invalid" $name) (eq (toString $name) "") }}
{{- fail (printf "%s is required: the name of a Secret" $path) }}
{{- end }}
{{- $bad := false }}
{{- if or (not (kindIs "string" $name)) (gt (len (toString $name)) 63) (not (regexMatch "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$" (toString $name))) }}
{{- $bad = true }}
{{- else }}
{{- range regexSplit "[-.]" $name -1 }}
{{- if and (ge (len .) 16) (regexMatch "[0-9]" .) }}{{ $bad = true }}{{ end }}
{{- end }}
{{- end }}
{{- if $bad }}
{{- fail (printf "%s must be the name of a Secret (at most 63 lower-case letters, digits, - and .), never a secret's value" $path) }}
{{- end }}
{{- $name }}
{{- end }}

{{/*
The platform's Secrets' names, checked. Call with (list . "postgres"): one
of existingSecrets' keys (postgres, api, internalServices, oidcGoogle,
mail).
*/}}
{{- define "telflo.secretName" -}}
{{- $ := index . 0 }}
{{- $key := index . 1 }}
{{- include "telflo.checkedSecretName" (list (index $.Values.existingSecrets $key) (printf "existingSecrets.%s" $key)) }}
{{- end }}

{{/*
The opamp-server's Secret's name (opamp-server.auth.existingSecret),
checked: Postgres reads its owner-password and runtime-password, the API
its management-secret.
*/}}
{{- define "telflo.opampSecretName" -}}
{{- include "telflo.checkedSecretName" (list (dig "auth" "existingSecret" "" (index .Values "opamp-server")) "opamp-server.auth.existingSecret") }}
{{- end }}

{{/*
The guards: every value the schema can't check, and every one whose
refusal must not quote it. Each fails the render with a fixed message
naming the value's path, never its value.
*/}}
{{- define "telflo.guards" -}}
{{- $v := .Values }}
{{- $o := index $v "opamp-server" }}
{{- $api := $v.api }}

{{- /* Required values. */}}
{{- $_ := required "publicUrl is required: the gateway's public origin, such as https://telflo.example.com" $v.publicUrl }}
{{- if not (regexMatch "^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$" (toString $v.publicUrl)) }}
{{- fail "publicUrl must be an http or https origin (a host and an optional port), with no user name, password, path, query or fragment" }}
{{- end }}
{{- $_ = required "opamp-server.server.publicUrl is required: the agent endpoint's URL as collectors reach it, such as https://opamp.example.com/opamp/api/v1" (dig "server" "publicUrl" "" $o) }}
{{- /*
The agent URL: the API hands it to every collector and its start-up error
would quote it, so it has the contracts' agent-endpoint shape
(AGENT_ENDPOINT_PATTERN, TELFLO_OPAMP_AGENT_PUBLIC_URL's rule): http, https,
ws or wss, a host or an IP address, an optional port, a path; no user name,
password, query or fragment. (The opamp-server chart's own schema refuses a
scheme other than http or https first, quoting it.)
*/}}
{{- if not (regexMatch "^(https?|wss?)://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]+\\])(:[0-9]{1,5})?(/[A-Za-z0-9._~%/+-]*)?$" (toString (dig "server" "publicUrl" "" $o))) }}
{{- fail "opamp-server.server.publicUrl must be an http, https, ws or wss URL with a host, an optional port and a path of letters, digits and ._~%/+- (no user name, password, query or fragment)" }}
{{- end }}
{{- $_ = required "api.mail.from is required: the sender address of the platform's email" $api.mail.from }}
{{- if eq $api.mail.transport "smtp" }}
{{- $_ = required "api.mail.smtp.host is required while api.mail.transport is smtp" $api.mail.smtp.host }}
{{- end }}
{{- /*
A host name or an IPv4 address, or an IPv6 literal without brackets (two
colons at least, so a host:port never passes as one), as nodemailer takes it.
*/}}
{{- with $api.mail.smtp.host }}
{{- if not (or (regexMatch "^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$" (toString .)) (regexMatch "^[0-9A-Fa-f]*:[0-9A-Fa-f]*:[0-9A-Fa-f:.]*$" (toString .))) }}
{{- fail "api.mail.smtp.host must be a host name or address (letters, digits, . and -, or an IPv6 address without brackets), with no user name, password or port" }}
{{- end }}
{{- end }}
{{- /* The mail's CA Secret: a Secret's name, mounted only with smtp. */}}
{{- with $api.mail.smtp.caSecret }}
{{- $_ = include "telflo.checkedSecretName" (list . "api.mail.smtp.caSecret") }}
{{- end }}

{{- /*
The site: the rules the API's settings and the web's loader refuse at start,
refused here first with fixed words naming the value, never quoting it. A
URL is an https URL with a host (letters, digits, . and -), an optional port
and an optional path, query or fragment of URL characters, or a path
starting with a single / (the contracts' SITE_URL_PATTERN).
*/}}
{{- /*
Each value of its own type: site and site.terms maps (checked before any
field is read), a null value (which Helm drops before the schema sees it) or
one of another type refused, never rendered (Go would print "<nil>"), and
the API would refuse it only at start. A null site or site.terms is an empty
map here, its values then refused one by one.
*/}}
{{- if not (or (kindIs "invalid" $v.site) (kindIs "map" $v.site)) }}
{{- fail "site must be a map of the site's values" }}
{{- end }}
{{- $site := default dict $v.site }}
{{- if not (or (kindIs "invalid" $site.terms) (kindIs "map" $site.terms)) }}
{{- fail "site.terms must be a map of version, termsUrl, privacyUrl and cookiePolicyUrl" }}
{{- end }}
{{- $terms := default dict $site.terms }}
{{- range $key := list "playground" "anonymousValidate" "publicFlows" "salesInquiry" "emailNotifications" }}
{{- if not (kindIs "bool" (index $site $key)) }}
{{- fail (printf "site.%s must be true or false, not null or another type" $key) }}
{{- end }}
{{- end }}
{{- range $path, $value := dict "site.registration" $site.registration "site.docsUrl" $site.docsUrl "site.terms.version" $terms.version "site.terms.termsUrl" $terms.termsUrl "site.terms.privacyUrl" $terms.privacyUrl "site.terms.cookiePolicyUrl" $terms.cookiePolicyUrl }}
{{- if not (kindIs "string" $value) }}
{{- fail (printf "%s must be a string, not null or another type" $path) }}
{{- end }}
{{- end }}
{{- if and $site.playground (not (and $site.anonymousValidate $site.publicFlows)) }}
{{- fail "site.playground needs site.anonymousValidate and site.publicFlows true: the playground uses both" }}
{{- end }}
{{- if and $site.salesInquiry (not $api.salesInquiryTo) }}
{{- fail "api.salesInquiryTo is required while site.salesInquiry is true: where the inquiries go" }}
{{- end }}
{{- $siteUrl := "^(https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][A-Za-z0-9._~%!$&()*+,;=:@/?#-]*)?|/([A-Za-z0-9._~%!$&()*+,;=:@?#-][A-Za-z0-9._~%!$&()*+,;=:@/?#-]*)?)$" }}
{{- range $path, $url := dict "site.docsUrl" $site.docsUrl "site.terms.termsUrl" $terms.termsUrl "site.terms.privacyUrl" $terms.privacyUrl "site.terms.cookiePolicyUrl" $terms.cookiePolicyUrl }}
{{- if and $url (not (regexMatch $siteUrl (toString $url))) }}
{{- fail (printf "%s must be an https URL (a host, an optional port and path, no user name or password) or a path starting with a single /, of URL characters only" $path) }}
{{- end }}
{{- end }}
{{- with $terms.version }}
{{- if not (regexMatch "^[A-Za-z0-9._-]{1,32}$" (toString .)) }}
{{- fail "site.terms.version must be 1 to 32 letters, digits, dots, underscores and hyphens" }}
{{- end }}
{{- if not (and $terms.termsUrl $terms.privacyUrl) }}
{{- fail "site.terms.version needs site.terms.termsUrl and site.terms.privacyUrl: what is accepted must be readable" }}
{{- end }}
{{- end }}

{{- /*
The images' registries and repositories: shapes the schema leaves to the
guards, so a refusal never quotes a value (a pasted reference may hold a
user and password).
*/}}
{{- if not (regexMatch "^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?(/[a-z0-9]+([._-]+[a-z0-9]+)*)*$" (toString $v.image.registry)) }}
{{- fail "image.registry must be a registry host (and port), then path parts, with no user name or password" }}
{{- end }}
{{- range $key := list "api" "web" "gateway" "otelcolValidator" "otelcolTesting" "ottlEvaluator" "postgres" }}
{{- $image := (index $v $key).image }}
{{- if not (regexMatch "^([A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?(/[a-z0-9]+([._-]+[a-z0-9]+)*)*)?$" (toString $image.registry)) }}
{{- fail (printf "%s.image.registry must be empty or a registry host (and port), then path parts, with no user name or password" $key) }}
{{- end }}
{{- if not (regexMatch "^[a-z0-9]+([._-]+[a-z0-9]+)*(/[a-z0-9]+([._-]+[a-z0-9]+)*)*$" (toString $image.repository)) }}
{{- fail (printf "%s.image.repository must be an image's path (lower-case letters, digits, . _ - and /)" $key) }}
{{- end }}
{{- end }}

{{- /* Secret names: required where read, always shaped like a name. */}}
{{- $_ = include "telflo.secretName" (list . "postgres") }}
{{- $_ = include "telflo.secretName" (list . "api") }}
{{- $_ = include "telflo.secretName" (list . "internalServices") }}
{{- if or $api.oidcGoogle.enabled $v.existingSecrets.oidcGoogle }}
{{- $_ = include "telflo.secretName" (list . "oidcGoogle") }}
{{- end }}
{{- if or (eq $api.mail.transport "sendgrid") (and (eq $api.mail.transport "smtp") $api.mail.smtp.auth) $v.existingSecrets.mail }}
{{- $_ = include "telflo.secretName" (list . "mail") }}
{{- end }}
{{- $_ = include "telflo.opampSecretName" . }}
{{- range $i, $s := $v.global.imagePullSecrets }}
{{- $_ = include "telflo.checkedSecretName" (list $s.name (printf "global.imagePullSecrets[%d].name" $i)) }}
{{- end }}

{{- /* The opamp-server chart's wiring to the platform. */}}
{{- if ne (dig "fullnameOverride" "" $o) (include "telflo.opampFullname" .) }}
{{- fail "opamp-server.fullnameOverride must be telflo-opamp-server: the API's management URL and Postgres's bootstrap name it" }}
{{- end }}
{{- if dig "postgres" "enabled" false $o }}
{{- fail "opamp-server.postgres.enabled must be false: the platform's one Postgres (telflo-postgres) holds the opamp-server's database" }}
{{- end }}
{{- $db := dig "externalDatabase" dict $o }}
{{- if or (ne (toString (dig "host" "" $db)) "telflo-postgres") (ne (toString (dig "database" "" $db)) "telflo_opamp_server") (ne (int (dig "port" 0 $db)) 5432) }}
{{- fail "opamp-server.externalDatabase must be the platform's Postgres: host telflo-postgres, port 5432, database telflo_opamp_server" }}
{{- end }}
{{- if ne (toJson (default list $v.global.imagePullSecrets)) (toJson (default list (dig "imagePullSecrets" list $o))) }}
{{- fail "opamp-server.imagePullSecrets must be the same list as global.imagePullSecrets: the opamp-server chart reads only its own" }}
{{- end }}
{{- $opampPolicy := dig "networkPolicy" "enabled" false $o }}
{{- if ne (toString $opampPolicy) (toString $v.networkPolicy.enabled) }}
{{- fail "opamp-server.networkPolicy.enabled must equal networkPolicy.enabled" }}
{{- end }}
{{- if and $opampPolicy (not (dig "networkPolicy" "management" "from" list $o)) }}
{{- fail "opamp-server.networkPolicy.management.from must not be empty while its policies are on: it names the API's pods" }}
{{- end }}

{{- /* The API's file store. */}}
{{- if and (eq $api.fileStore.kind "local") (gt (int $api.replicas) 1) }}
{{- fail "api.replicas must be 1 while api.fileStore.kind is local: its volume is ReadWriteOnce" }}
{{- end }}
{{- if eq $api.fileStore.kind "s3" }}
{{- $_ = required "api.fileStore.bucket is required while api.fileStore.kind is s3" $api.fileStore.bucket }}
{{- $_ = required "api.fileStore.region is required while api.fileStore.kind is s3" $api.fileStore.region }}
{{- end }}
{{- with $api.fileStore.endpoint }}
{{- if not (regexMatch "^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$" (toString .)) }}
{{- fail "api.fileStore.endpoint must be an http or https origin (a host and an optional port), with no user name, password, path, query or fragment" }}
{{- end }}
{{- end }}

{{- /* The gateway's Service. */}}
{{- $svc := $v.gateway.service }}
{{- /* An empty or null type is a LoadBalancer, as gateway.yaml renders it. */}}
{{- $svcType := default "LoadBalancer" $svc.type }}
{{- if and $svc.loadBalancerSourceRanges (ne $svcType "LoadBalancer") }}
{{- fail "gateway.service.loadBalancerSourceRanges needs gateway.service.type LoadBalancer" }}
{{- end }}
{{- if and $svc.externalTrafficPolicy (eq $svcType "ClusterIP") }}
{{- fail "gateway.service.externalTrafficPolicy needs gateway.service.type LoadBalancer or NodePort" }}
{{- end }}

{{- /*
gateway.extraRoutes. The schema's checks repeated (a render with
--skip-schema-validation must not write anything else into nginx's
configuration; a port a number, never text), no empty, . or .. segment in a
path (nginx matches the normalised path, so such a route would only look
like a hole), then the shadow guard: no route may take a path the platform
answers. React Router matches without case, so the comparison is in lower
case: a prefix / is refused; and for each platform root R
(telflo.platformRoots), a path equal to /R, starting /R/ (its pages) or /R.
(its data requests, /login.data; a file's name), or a prefix route that /R
starts with (/ap would take /api and /app). An exact /, /robots.txt and
/home/ are allowed. Two routes of the same match and path are refused too
(nginx wouldn't start). Fixed words, naming the entry's index and the
platform's root, never the value.
*/}}
{{- $routes := $v.gateway.extraRoutes }}
{{- if not (or (kindIs "invalid" $routes) (kindIs "slice" $routes)) }}
{{- fail "gateway.extraRoutes must be a list of {path, match, service, port}" }}
{{- end }}
{{- $roots := splitList " " (include "telflo.platformRoots" .) }}
{{- $seen := dict }}
{{- range $i, $r := default list $routes }}
{{- if not (kindIs "map" $r) }}
{{- fail (printf "gateway.extraRoutes[%d] must be a map of path, match, service and port" $i) }}
{{- end }}
{{- if not (and (kindIs "string" $r.path) (le (len (toString $r.path)) 200) (regexMatch "^/[A-Za-z0-9._~/-]*$" (toString $r.path))) }}
{{- fail (printf "gateway.extraRoutes[%d].path must be at most 200 characters: a leading / then letters, digits and ._~/-" $i) }}
{{- end }}
{{- if regexMatch "(^|/)\\.{1,2}(/|$)|//" $r.path }}
{{- fail (printf "gateway.extraRoutes[%d].path must hold no empty, . or .. segment (nginx matches the normalised path)" $i) }}
{{- end }}
{{- if not (and (kindIs "string" $r.match) (has (toString $r.match) (list "exact" "prefix"))) }}
{{- fail (printf "gateway.extraRoutes[%d].match must be exact or prefix" $i) }}
{{- end }}
{{- if not (and (kindIs "string" $r.service) (le (len (toString $r.service)) 63) (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" (toString $r.service))) }}
{{- fail (printf "gateway.extraRoutes[%d].service must be a Service's name in this namespace (at most 63 lower-case letters, digits and -)" $i) }}
{{- end }}
{{- $portOk := false }}
{{- if or (kindIs "int" $r.port) (kindIs "int64" $r.port) (kindIs "float64" $r.port) }}
{{- $portOk = and (eq (toString $r.port) (toString (int64 $r.port))) (ge (int64 $r.port) 1) (le (int64 $r.port) 65535) }}
{{- end }}
{{- if not $portOk }}
{{- fail (printf "gateway.extraRoutes[%d].port must be a port, 1 to 65535" $i) }}
{{- end }}
{{- $lp := lower $r.path }}
{{- $prefix := eq $r.match "prefix" }}
{{- if and $prefix (eq $lp "/") }}
{{- fail (printf "gateway.extraRoutes[%d]: a prefix / would take every path the platform answers" $i) }}
{{- end }}
{{- range $roots }}
{{- $root := printf "/%s" . }}
{{- if or (eq $lp $root) (hasPrefix (printf "%s/" $root) $lp) (hasPrefix (printf "%s." $root) $lp) (and $prefix (hasPrefix $lp $root)) }}
{{- fail (printf "gateway.extraRoutes[%d].path would shadow the platform's %s" $i $root) }}
{{- end }}
{{- end }}
{{- $key := printf "%s %s" $r.match $r.path }}
{{- if hasKey $seen $key }}
{{- fail (printf "gateway.extraRoutes[%d] repeats an earlier route's match and path" $i) }}
{{- end }}
{{- $_ = set $seen $key true }}
{{- end }}

{{- /*
One release per namespace (the objects' names are fixed). lookup reads the
cluster during install and upgrade only (helm template and lint see
nothing); telflo.oneReleaseGuard decides.
*/}}
{{- $_ = include "telflo.oneReleaseGuard" (list (lookup "v1" "Service" .Release.Namespace (include "telflo.apiName" .)) .Release.Name) }}
{{- end }}

{{/*
The platform's roots, the first segment of every path the gateway sends to
the platform (gateway.extraRoutes' shadow guard): the web app's routes'
first segments (telflo-core/apps/web/app/routes.ts, robots.txt aside: a
site may answer it), the entries of its public/ folder, and api, assets
(the built files), __manifest (React Router's route discovery), _root.data
(the index's data), quick-deploy and library-links (the gateway's own 404s
for those typed without /api/). One line, sorted: a render case holds it
equal to those sources.
*/}}
{{- define "telflo.platformRoots" -}}__manifest _root.data accept-invitation api app assets check-your-email cli-auth docs editor favicon.ico fleet-management forgot-password library library-links login org-admin playground product-admin public-editor quick-deploy register reset-password schemas settings telflo-logo-dark.svg telflo-logo-full.svg variables verify-email{{- end }}

{{/*
gateway.extraRoutes as nginx locations, the file default.conf includes
(/etc/nginx/telflo/extra-routes.conf), inside its server block: each
`location = <path>` (exact) or `location ^~ <path>` (prefix: nginx's regex
locations never take its paths), logging crit and worse only (an upstream's
failure would quote the request line), proxied to
<service>.<namespace>.svc:<port> with no URI (the request's own passes
through). Empty when the list is. The guards have checked every value.
*/}}
{{- define "telflo.gatewayExtraRoutes" -}}
{{- $out := "" }}
{{- range $r := default list .Values.gateway.extraRoutes }}
{{- $out = printf "%slocation %s %s {\n    error_log /var/log/nginx/error.log crit;\n    proxy_pass http://%s.%s.svc:%d;\n}\n" $out (ternary "=" "^~" (eq $r.match "exact")) $r.path $r.service $.Release.Namespace (int $r.port) }}
{{- end }}
{{- $out }}
{{- end }}

{{/*
The one-release decision, apart so the render tests can call it with fake
objects. Call with (list <the telflo-api Service lookup found, or an empty
map> <the release's name>): an existing Service that this release doesn't
own (its meta.helm.sh/release-name annotation another name, or none) fails
with a fixed message. The backstop: Helm 4 itself refuses to adopt another
release's objects (or objects no release owns) unless run with
--take-ownership, which this still refuses.
*/}}
{{- define "telflo.oneReleaseGuard" -}}
{{- $existing := index . 0 }}
{{- $release := index . 1 }}
{{- if $existing }}
{{- if ne (toString (dig "metadata" "annotations" "meta.helm.sh/release-name" "" $existing)) (toString $release) }}
{{- fail "this namespace already holds another telflo release (or a Service named telflo-api): one release per namespace" }}
{{- end }}
{{- end }}
{{- end }}
