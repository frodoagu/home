{{/*
Expand the name of the chart.
*/}}
{{- define "cloudflare-ddns.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "cloudflare-ddns.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "cloudflare-ddns.labels" -}}
app.kubernetes.io/name: {{ include "cloudflare-ddns.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "cloudflare-ddns.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cloudflare-ddns.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the secret holding the Cloudflare API token.
*/}}
{{- define "cloudflare-ddns.secretName" -}}
{{- .Values.cloudflare.existingSecret | default (printf "%s-token" (include "cloudflare-ddns.fullname" .)) }}
{{- end }}
