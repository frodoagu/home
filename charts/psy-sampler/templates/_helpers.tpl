{{/*
Expand the name of the chart.
*/}}
{{- define "psy-sampler.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "psy-sampler.fullname" -}}
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
Create chart label.
*/}}
{{- define "psy-sampler.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "psy-sampler.labels" -}}
helm.sh/chart: {{ include "psy-sampler.chart" . }}
{{ include "psy-sampler.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "psy-sampler.selectorLabels" -}}
app.kubernetes.io/name: {{ include "psy-sampler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Cloud-save backend (psy-sync). Its own name label, so the nginx Service's
selector (name + instance) never picks its pods.
*/}}
{{- define "psy-sampler.syncName" -}}
{{- printf "%s-sync" (include "psy-sampler.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "psy-sampler.syncSelectorLabels" -}}
app.kubernetes.io/name: {{ include "psy-sampler.name" . }}-sync
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "psy-sampler.syncLabels" -}}
helm.sh/chart: {{ include "psy-sampler.chart" . }}
{{ include "psy-sampler.syncSelectorLabels" . }}
app.kubernetes.io/component: sync
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
