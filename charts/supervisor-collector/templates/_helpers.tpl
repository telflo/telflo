{{/*
The objects' name: a gateway's group name (its Service's address); else
fullnameOverride when set (the platform passes `<the fleet id's first 8
characters>-<the group's slug>`, e.g. 3f9a1c2e-default, so two fleets' Agents
and Clusters can share a cluster); else telflo-cluster / telflo-node. Callers
quote it: a name such as `on` must stay a string under YAML 1.1.
*/}}
{{- define "tsc.fullname" -}}
{{- if eq .Values.role "gateway" -}}
{{ .Values.group }}
{{- else if .Values.fullnameOverride -}}
{{ .Values.fullnameOverride }}
{{- else if eq .Values.role "cluster" -}}
telflo-cluster
{{- else -}}
telflo-node
{{- end -}}
{{- end -}}

{{- define "tsc.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/* Quoted by its callers, as tsc.fullname. */}}
{{- define "tsc.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}{{ .Values.serviceAccount.name }}{{- else -}}{{ include "tsc.fullname" . }}{{- end -}}
{{- end -}}

{{/*
User-defined extra volume mounts + volumes (from .Values.volumes; v1 = hostPath).
Pre-indented to match the workload templates (mounts at 12 spaces, volumes at 8),
so callers include them with a plain `{{- include ... }}` (no nindent). The volume
name is derived identically here and below so each mount pairs with its volume.
Call each guarded by `{{- if .Values.volumes }}`.

readOnly uses an explicit kindIs test, NOT `.readOnly | default true`: Go
templates treat `false` as empty, so `default` fires on an explicit `false`
exactly as it does on an unset key, silently turning every writable mount
read-only. That shipped once and produced an invisible collector crash loop
(file_storage could not open its bbolt file; the supervisor kept polling
happily). tests/render-tests.sh pins all three cases.
*/}}
{{- define "tsc.extraVolumeMounts" -}}
{{- range .Values.volumes }}
            - name: {{ printf "extra-%s" (regexReplaceAll "[^a-z0-9]+" (.mountPath | trimPrefix "/" | lower) "-" | trimPrefix "-" | trimSuffix "-") | trunc 63 | trimSuffix "-" }}
              mountPath: {{ .mountPath | quote }}
              readOnly: {{ if kindIs "bool" .readOnly }}{{ .readOnly }}{{ else }}true{{ end }}
{{- end }}
{{- end -}}

{{- define "tsc.extraVolumes" -}}
{{- range .Values.volumes }}
        - name: {{ printf "extra-%s" (regexReplaceAll "[^a-z0-9]+" (.mountPath | trimPrefix "/" | lower) "-" | trimPrefix "-" | trimSuffix "-") | trunc 63 | trimSuffix "-" }}
          hostPath:
            path: {{ .hostPath | quote }}
            type: {{ .hostPathType | default "Directory" | quote }}
{{- end }}
{{- end -}}

{{/*
Pod-level securityContext, emitted only when .Values.clickhouse.endpoint is
set (contrib pods get no securityContext block at all, so contrib renders
byte-identical). The ClickStack image runs as uid 10001 (non-root); contrib
runs as root. A k8s volume mount comes up root-owned regardless of the
image's build-time chown, so uid 10001 needs help to write it:
  - cluster/gateway (PVC-backed): fsGroup makes the volume group-writable
    by 10001 — this is the load-bearing setting for those two roles.
  - node (hostPath-backed): fsGroup does NOT reliably apply to hostPath
    volumes, so node additionally gets a root initContainer that chowns the
    mount (see node-daemonset.yaml).
runAsUser/runAsGroup are set alongside fsGroup for clarity/consistency with
the image's actual runtime uid, though fsGroup is what fixes the bug.
Pre-indented to 6 spaces (pod spec level in all three workload templates);
call with a plain `{{- include ... }}` right after serviceAccountName.
*/}}
{{- define "tsc.podSecurityContext" -}}
{{- if .Values.clickhouse.endpoint }}
      securityContext:
        fsGroup: 10001
        runAsUser: 10001
        runAsGroup: 10001
{{- end -}}
{{- end -}}

{{/*
Collector container env. Contrib set is emitted always; the ClickStack block
(CLICKHOUSE_* + OPAMP_SERVER_URL) is emitted only when .Values.clickhouse.endpoint
is set, so contrib deploys render byte-identical env. Pre-indented to 12 spaces.
*/}}
{{- define "tsc.collectorEnv" }}
            - name: OPAMP_TOKEN
              valueFrom: { secretKeyRef: { name: {{ printf "%s-token" (include "tsc.fullname" .) | quote }}, key: token } }
            - name: OPAMP_ENDPOINT
              value: {{ .Values.endpoint | quote }}
            - name: OPAMP_ALLOW_INSECURE_CONNECTIONS
              value: {{ .Values.allowInsecure | default false | quote }}
            - name: COLLECTOR_GROUP_ID
              value: {{ .Values.collectorGroupId | quote }}
            - name: POD_NAMESPACE
              valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: NODE_NAME
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
            - name: HOST_IP
              valueFrom: { fieldRef: { fieldPath: status.podIP } }
            - name: OPAMP_SERVER_NAME
              value: $(POD_NAME)
{{- if .Values.clickhouse.endpoint }}
            - name: OPAMP_SERVER_URL
              value: {{ .Values.endpoint | quote }}
            - name: CLICKHOUSE_ENDPOINT
              value: {{ .Values.clickhouse.endpoint | quote }}
            - name: CLICKHOUSE_USER
              value: {{ .Values.clickhouse.user | quote }}
            - name: HYPERDX_OTEL_EXPORTER_CLICKHOUSE_DATABASE
              value: {{ .Values.clickhouse.database | quote }}
            - name: CLICKHOUSE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.clickhouse.existingSecret | default (printf "%s-clickhouse" (include "tsc.fullname" .)) | quote }}
                  key: {{ .Values.clickhouse.passwordKey | default "CLICKHOUSE_PASSWORD" }}
{{- end }}
{{- end -}}

{{/*
envFrom block delivering .Values.collectorEnv via the chart-created Secret
(collector-env-secret.yaml). A sibling of env:, pre-indented to 10 spaces.
Explicit env entries win over envFrom on name collisions, so collectorEnv can
never override the OPAMP/identity vars tsc.collectorEnv sets.
*/}}
{{- define "tsc.collectorEnvFrom" }}
{{- if .Values.collectorEnv }}
          envFrom:
            - secretRef:
                name: {{ printf "%s-collector-env" (include "tsc.fullname" .) | quote }}
{{- end }}
{{- end -}}

{{/*
Pod-template annotations that change whenever the token or collectorEnv
changes. The pods read both Secrets by NAME, so a new value alone would update
the Secret without touching the pod spec: no rollout, the pods keep the stale
value. The checksums force the rollout.
  checksum/token          always: the sha256 of the rendered token Secret
                          (secret.yaml), so a new token rolls the pods. It
                          changes with that Secret's text: the token and the
                          Secret's name (the fullname). A hash of the sealed
                          bearer, never the bearer. The include re-runs the
                          guards inside each workload.
  checksum/collector-env  only when collectorEnv is set, as in 0.3.5.
Pre-indented to 6 spaces (pod template metadata).
*/}}
{{- define "tsc.podChecksums" }}
      annotations:
        checksum/token: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
{{- if .Values.collectorEnv }}
        checksum/collector-env: {{ .Values.collectorEnv | toJson | sha256sum }}
{{- end }}
{{- end -}}
