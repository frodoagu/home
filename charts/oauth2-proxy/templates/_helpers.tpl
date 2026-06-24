{{/*
Expand the name of the chart.
*/}}
{{- define "oauth2-proxy-wrapper.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The oauth2-proxy upstream chart uses fullnameOverride: oauth2-proxy (set in
values.yaml), so the service is always named "oauth2-proxy".  We expose the
same name here for use in the IngressRoute.
*/}}
{{- define "oauth2-proxy-wrapper.serviceName" -}}
{{- "oauth2-proxy" }}
{{- end }}
