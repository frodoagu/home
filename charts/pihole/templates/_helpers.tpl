{{/*
Expand the name of the chart.
*/}}
{{- define "pihole.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "pihole.fullname" -}}
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
{{- define "pihole.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "pihole.labels" -}}
helm.sh/chart: {{ include "pihole.chart" . }}
{{ include "pihole.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "pihole.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pihole.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Render dhcp.reservations into the value Pi-hole's FTLCONF_dhcp_hosts expects:
semicolon-separated "mac,ip,name" entries (name optional). Empirically verified:
FTLCONF_dhcp_hosts="MAC,IP,name;MAC2,IP2,name2" parses into the TOML array, with
the commas inside each entry preserved.
*/}}
{{- define "pihole.dhcpHosts" -}}
{{- $entries := list -}}
{{- range .Values.dhcp.reservations -}}
{{- $e := printf "%s,%s" (required "each dhcp reservation needs a mac" .mac) (required "each dhcp reservation needs an ip" .ip) -}}
{{- if .name }}{{- $e = printf "%s,%s" $e .name -}}{{- end -}}
{{- $entries = append $entries $e -}}
{{- end -}}
{{- join ";" $entries -}}
{{- end }}

{{/*
Render dns.localRecords into the value Pi-hole's FTLCONF_dns_hosts expects:
semicolon-separated entries in hosts-file syntax, "IP host1 host2 ...", per
Pi-hole's dns.hosts config key (FTL parses env-var arrays on ";" or "\n").
*/}}
{{- define "pihole.dnsHosts" -}}
{{- $entries := list -}}
{{- range .Values.dns.localRecords -}}
{{- $ip := required "each dns local record needs an ip" .ip -}}
{{- $hosts := required "each dns local record needs at least one host" .hosts -}}
{{- $entries = append $entries (printf "%s %s" $ip (join " " $hosts)) -}}
{{- end -}}
{{- join ";" $entries -}}
{{- end }}
