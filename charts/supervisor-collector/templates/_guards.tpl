{{/*
The chart's guards, called from secret.yaml's first line. Helm aborts the
whole render on any template's fail, and every workload's checksum/token
includes secret.yaml, so no object renders past a bad value. Each check tests
the value's kind before its length or pattern, and each message names the
key, never its value. (Helm 4's `helm lint` only logs a fail: the render
tests, tests/render-tests.sh, carry every guard.)
*/}}
{{- define "tsc.guard" -}}
{{- if not (has .Values.role (list "node" "cluster" "gateway")) -}}
{{- fail "role must be one of: node, cluster, gateway" -}}
{{- end -}}
{{- if eq .Values.role "gateway" -}}
{{- if not .Values.group -}}{{- fail "gateway role requires a group name" -}}{{- end -}}
{{- if not (kindIs "string" .Values.group) -}}{{- fail "group must be a string" -}}{{- end -}}
{{- if or (gt (len .Values.group) 52) (not (regexMatch "^[a-z]([-a-z0-9]*[a-z0-9])?$" .Values.group)) -}}
{{- fail "group must be a DNS-1035 label of at most 52 characters for a gateway" -}}
{{- end -}}
{{- if has .Values.group (list "node" "cluster" "telflo-node" "telflo-cluster") -}}
{{- fail "group must not be node, cluster, telflo-node or telflo-cluster for a gateway" -}}
{{- end -}}
{{- end -}}
{{- if .Values.fullnameOverride -}}
{{- if not (kindIs "string" .Values.fullnameOverride) -}}
{{- fail "fullnameOverride must be a DNS-1123 label of at most 52 characters" -}}
{{- end -}}
{{- if or (gt (len .Values.fullnameOverride) 52) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" .Values.fullnameOverride)) -}}
{{- fail "fullnameOverride must be a DNS-1123 label of at most 52 characters" -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "string" .Values.collectorGroupId) -}}
{{- fail "collectorGroupId must be a collector group's id (a UUID)" -}}
{{- end -}}
{{- if not (regexMatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" .Values.collectorGroupId) -}}
{{- fail "collectorGroupId must be a collector group's id (a UUID)" -}}
{{- end -}}
{{- /* Absent (null, or a --reuse-values upgrade from a chart without it) is false. */ -}}
{{- if not (or (kindIs "bool" .Values.kubeletProxy) (kindIs "invalid" .Values.kubeletProxy)) -}}
{{- fail "kubeletProxy must be true or false" -}}
{{- end -}}
{{- if or (not .Values.endpoint) (not .Values.token) -}}
{{- fail "endpoint and token are required" -}}
{{- end -}}
{{- end -}}
