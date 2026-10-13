{{/*
Expand the name of the chart.
*/}}
{{- define "psy-sampler-previews.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart label.
*/}}
{{- define "psy-sampler-previews.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "psy-sampler-previews.labels" -}}
helm.sh/chart: {{ include "psy-sampler-previews.chart" . }}
app.kubernetes.io/name: {{ include "psy-sampler-previews.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
