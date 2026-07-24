{{/*
Expand the name of the chart.
*/}}
{{- define "shelly-config.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "shelly-config.fullname" -}}
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
{{- define "shelly-config.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "shelly-config.labels" -}}
helm.sh/chart: {{ include "shelly-config.chart" . }}
{{ include "shelly-config.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "shelly-config.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shelly-config.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Pod spec for the reconcile run. Shared verbatim by the CronJob (periodic
self-heal) and the PostSync hook Job (apply a git change immediately), so the
two can never drift apart.
*/}}
{{- define "shelly-config.podSpec" -}}
restartPolicy: Never
securityContext:
  runAsNonRoot: true
  runAsUser: 65534
  runAsGroup: 65534
containers:
  - name: reconcile
    image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
    imagePullPolicy: {{ .Values.image.pullPolicy }}
    command: ["python3", "/app/reconcile.py"]
    env:
      # The device inventory, verbatim from values.yaml.
      - name: SHELLY_DEVICES
        value: {{ .Values.devices | toJson | quote }}
      - name: RPC_TIMEOUT
        value: {{ .Values.rpcTimeout | quote }}
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
    volumeMounts:
      - name: app
        mountPath: /app
        readOnly: true
      - name: scripts
        mountPath: /scripts
        readOnly: true
    resources:
      {{- toYaml .Values.resources | nindent 6 }}
volumes:
  - name: app
    configMap:
      name: {{ include "shelly-config.fullname" . }}-reconcile
  - name: scripts
    configMap:
      name: {{ include "shelly-config.fullname" . }}-scripts
{{- end }}
