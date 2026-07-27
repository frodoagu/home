# Nivel del tubo de gas (Mopeka M1001 + ESP32/ESPHome)

Monitoreo del nivel del **tubo de 45 kg** con un sensor ultrasónico **Mopeka
M1001** ("Standard Check"), que se pega con imanes abajo del tanque y mide por
tiempo de vuelo la altura de la columna de propano líquido.

| Pieza | Dónde vive |
|---|---|
| Firmware del receptor BLE | [`esphome/mopeka-gas.yaml`](../esphome/mopeka-gas.yaml) |
| Sensores derivados + alertas | [`charts/home-assistant/packages/gas.yaml`](../charts/home-assistant/packages/gas.yaml) |
| Bot de Telegram | [`charts/home-assistant/packages/telegram.yaml`](../charts/home-assistant/packages/telegram.yaml) |
| Plumbing del token | `telegram.*` en [`charts/home-assistant/values.yaml`](../charts/home-assistant/values.yaml) |

```
  Mopeka M1001  ──BLE advertisement──>  ESP32 (ESPHome)  ──API ESPHome──>  Home Assistant
  (bajo el tubo)   0xADA0 / mfr 0x000D   mopeka_std_check                   packages/gas.yaml
                                                                                  │
                                                                            notify.telegram
```

---

## 1. Por qué hay un ESP32 y no se usa la integración nativa de HA

**La integración `mopeka` de Home Assistant no soporta el M1001.** No es un
problema de configuración ni de alcance: es que el parser directamente lo
descarta. Vale la pena dejarlo escrito para no volver a investigarlo.

- El parser es [`mopeka-iot-ble`](https://github.com/Bluetooth-Devices/mopeka-iot-ble),
  y su tabla `DEVICE_TYPES` sólo conoce model bytes de la familia **Pro**: `0x3`
  Pro Check, `0x4` Pro-200, `0x5` Pro H2O, `0x6` Lippert BottleCheck, `0x8`/`0x9`
  Pro Plus, `0xA`/`0xB` TD40/TD200, `0xC` Pro Check Universal, `0x12` Pro-200B.
  El Standard no está.
- Además exige el **Pro service UUID** en el advertisement. El Standard anuncia
  el service UUID `0xADA0` con manufacturer id `0x000D` — otro protocolo.
- Resultado: HA lo loguea como *"Unsupported device"* y no crea ninguna entidad.

**Un `bluetooth_proxy` tampoco sirve.** Un proxy sólo retransmite los
advertisements hacia HA; el parser los sigue rechazando por lo mismo. No hay
posición del proxy que arregle esto.

**La integración HACS alternativa tampoco.**
[`phurth/ha-mopeka`](https://github.com/phurth/ha-mopeka) es también Pro-only
(Pro Check / Pro Plus / Pro H2O) y es un proyecto de 3 estrellas.

Lo único que decodifica este sensor es la plataforma
[`mopeka_std_check`](https://esphome.io/components/sensor/mopeka_std_check/) de
**ESPHome** (soporta los tipos `STANDARD`, `XL`, `ETRAILER`, `STANDARD_ALT`), así
que el parseo se hace en un ESP32 y a HA le llegan sensores ya digeridos por la
API de ESPHome. El Bluetooth de la Pi sigue sirviendo para los termómetros ATC
(ver [home-assistant.md](home-assistant.md#bluetooth)); para el Mopeka no.

---

## 2. Flasheo del ESP32

Los secretos van en `esphome/secrets.yaml` (gitignoreado; la plantilla es
`secrets.yaml.example`). Cada dispositivo tiene sus propias claves — las de este
son `mopeka_api_key` / `mopeka_ota_password`:

```bash
openssl rand -base64 32   # -> mopeka_api_key
```

La MAC del sensor (`mopeka_mac`) ya está puesta: **`34:14:B5:4B:A1:02`**. Si
alguna vez hay que reidentificarlo (sensor de repuesto, segundo tubo), **no hace
falta flashear a ciegas** — se lo encuentra desde cualquier máquina con BLE,
porque su firma es inconfundible: **manufacturer id `0x000D` con exactamente 23
bytes** de payload.

```bash
bluetoothctl --timeout 15 scan le
```

y buscar el device cuyo `ManufacturerData.Key` sea `0x000d`. Para confirmar que
es un Standard y no un Pro, el **segundo byte** del payload enmascarado con
`0xCF` tiene que dar `0x02` (`STANDARD`; los otros valores válidos son `0x03` XL,
`0x44` STANDARD_ALT, `0x46` ETRAILER).

El **botón verde de sync** no hace falta para esto: el sensor **emite igual sin
apretar nada**, sólo que más lento. El sync no lo "habilita", únicamente sube la
tasa de advertisement — el payload trae los flags `sync_pressed` y
`slow_update_rate` en los bits 7 y 6 del byte 3.

> Del mismo payload salen directo, sin ambigüedad de bitfields: batería
> (`(byte2/256·2+1,5)` V, escalada sobre 2,2–2,85 V para la CR2032) y temperatura
> (`(byte3 & 0x3F − 25) × 1,776964` °C). La distancia, en cambio, sale de 12
> pares tiempo/amplitud de 5 bits empaquetados, y ahí el orden de bits es
> delicado — no vale la pena replicarlo fuera del firmware.

Validación local antes de commitear, y flasheo por USB la primera vez (después ya
es OTA):

```bash
esphome config esphome/mopeka-gas.yaml            # valida
esphome compile esphome/mopeka-gas.yaml           # primer build de esp-idf: tarda
esphome upload esphome/mopeka-gas.yaml --device /dev/ttyUSB0
esphome logs esphome/mopeka-gas.yaml              # verificar que ve el sensor
```

El ESP32 va **cerca del tubo** (el BLE es el enlace corto), y necesita WiFi de
casa. El sensor `WiFi` (RSSI) está justamente para diagnosticar ese lado.

### Emparejarlo con Home Assistant

Esto **no está en git**, como todo lo que HA guarda en `.storage`: la config
entry de ESPHome la crea el config flow de la UI, igual que las de webOS y
Broadlink (ver [home-assistant.md](home-assistant.md#versioned-config-ha-packages)).

HA lo descubre solo por mDNS — funciona porque el pod corre con
`hostNetwork: true` y queda en la LAN física. Cuando aparezca en *Ajustes →
Dispositivos y servicios*, pide la **clave de cifrado de la API**: es
`mopeka_api_key` de `esphome/secrets.yaml` (gitignoreado).

Recién ahí existen las entidades `sensor.gas_tubo_*`, que son las que consume
`packages/gas.yaml`. Hasta entonces los templates de ese package se ven como no
disponibles, que es exactamente lo que corresponde.

---

## 3. Calibración del tubo de 45 kg

`tank_type: CUSTOM` es **obligatorio**. Los presets de ESPHome no llegan ni
cerca:

| Preset | Distancia lleno |
|---|---|
| `NORTH_AMERICA_20LB_VERTICAL` | 254 mm |
| `NORTH_AMERICA_30LB_VERTICAL` | 381 mm |
| `NORTH_AMERICA_40LB_VERTICAL` | 508 mm |
| `EUROPE_6KG` / `EUROPE_11KG` / `EUROPE_14KG` | 336 / 366 / 467 mm |
| **tubo 45 kg (este)** | **~860 mm** |

Todos los presets usan `empty = 38 mm` — es la zona muerta del sensor, no una
propiedad del tanque — así que se reusa ese valor. El `full = 860 mm` inicial es
**teórico**: ~88 L de propano (45 kg / 0,51 kg·L⁻¹) sobre un diámetro interno de
~36 cm.

El `%` sale de una regla de tres lineal sobre esa ventana, con tope en 100:

```
level = 100 / (full_mm - empty_mm) * (distance - empty_mm)
```

**Para recalibrar** con datos reales, mirar el sensor `sensor.gas_tubo_distancia`
(el crudo en mm, expuesto justamente para esto) con el tubo recién cambiado y
poner esa lectura en `distance_full`. Es un cambio en el YAML del ESP32 y un
reflasheo; los kilos, en cambio, se derivan en el package de HA, así que ese lado
se ajusta con un commit y un sync de ArgoCD.

### ⚠️ El tubo de 45 kg excede el rango del sensor

Mopeka especifica el Standard para tanques del orden de los 40 lb (~508 mm de
columna). Un tubo de 45 kg lleno tiene ~860 mm. Consecuencia práctica: **con el
tubo lleno el nivel se queda pegado cerca de 100 % y recién se vuelve fiel a
medida que baja.** El firmware ya topea en 100 % cuando `distance >= full_mm`.

Para "¿cuándo pido gas?" eso alcanza, porque la mitad útil es justamente la de
abajo. Si con datos reales molesta, la alternativa es calibrar `distance_full`
contra la **lectura máxima real** en vez de la teórica: el `%` pasa a ser fiel en
toda la banda legible, a costa de que "100 %" ya no signifique "lleno".

### Montaje

El sensor se sostiene con imanes contra la chapa del fondo del tanque, y necesita
un par de centímetros de despeje. En un tubo de 45 kg eso depende del hueco del
**aro de la base**. Tiene que ser acero (no sirve en cilindros de material
compuesto) y la superficie tiene que estar limpia: el acoplamiento acústico es
todo.

---

## 4. Gotcha: una lectura mala publica **0**, no "unavailable"

El gotcha central de este sensor, y la razón de cómo está escrito
`packages/gas.yaml`.

Cuando la calidad del eco es pobre, `mopeka_std_check` **no** marca el sensor
como no disponible: publica `distance = 0` **y** `level = 0` (en
`mopeka_std_check.cpp`: *"Poor read quality. Setting distance to 0."*). Es decir
que **un rebote feo es indistinguible de un tubo vacío**, y tomado en serio
dispararía la alerta de gas bajo con el tubo lleno.

Esto no es teórico: escaneando el sensor **apoyado sobre la mesa**, sin acoplar a
ningún tanque, las 12 amplitudes del advertisement vienen en cero — o sea que un
sensor despegado del tubo cae exactamente en este modo de falla y reportaría
"0 %" con toda tranquilidad.

El discriminador es la **distancia**: en un tubo realmente vacío la distancia cae
por debajo de los 38 mm de zona muerta pero **sigue siendo > 0**; sólo la lectura
mala publica exactamente `0`. Por eso todas las entidades derivadas cuelgan de:

```yaml
availability: "{{ states('sensor.gas_tubo_distancia') | float(0) > 0 }}"
```

Con una lectura mala se marcan **no disponibles** en lugar de mentir un 0 %. Ese
mismo template cubre gratis el caso de que el ESP32 se caiga.

Encima de eso hay debounce temporal, porque el líquido chapotea y el eco varía
entre advertisements: el `binary_sensor.gas_bajo` exige `delay_on: 02:00:00` y el
aviso crítico un `for: 02:00:00`.

---

## 5. Entidades

Las publica el ESP32 (`friendly_name: "Gas Tubo"`):

| Entidad | Qué es |
|---|---|
| `sensor.gas_tubo_nivel` | % crudo — **puede caer a 0 por lectura mala** |
| `sensor.gas_tubo_distancia` | mm crudos — el discriminador de §4 y la base de la calibración |
| `sensor.gas_tubo_temperatura_sensor` | temperatura del sensor (entra en la velocidad del sonido) |
| `sensor.gas_tubo_bateria_sensor` | CR2032, en % |
| `sensor.gas_tubo_wifi` | RSSI del ESP32 |

Y las derivadas, del package de HA:

| Entidad | Qué es |
|---|---|
| `sensor.gas_nivel` | el % **filtrado** (sin los ceros espurios) |
| `sensor.gas_restante` | kg restantes (`% × 45`) |
| `binary_sensor.gas_bajo` | `problem`, < 20 % sostenido 2 h |

`sensor` ya está en `googleAssistant.exposedDomains`, así que el nivel también
queda disponible en Google Home sin tocar nada.

---

## 6. Alertas por Telegram

Cuatro automations en `packages/gas.yaml`, todas contra la entidad
`notify.telegram_casa`:

| Automation | Dispara |
|---|---|
| `gas_aviso_bajo` | transición de `binary_sensor.gas_bajo` (< 20 % por 2 h) |
| `gas_aviso_critico` | `sensor.gas_nivel` < 10 % por 2 h |
| `gas_aviso_bateria_sensor` | CR2032 < 15 % por 1 h |
| `gas_aviso_sin_datos` | 12 h sin lecturas (ESP32 caído, sensor despegado) |

Las dos últimas existen para que el monitoreo **no se muera en silencio**: sin
ellas, el modo de falla es quedarse sin gas *y* sin aviso.

### El token

**Telegram no se configura desde este repo, y no se puede.** Desde 2026.7 la
integración `telegram_bot` es `config_flow: true`: no acepta configuración por
YAML, y un bloque `telegram_bot:` dentro de un package falla con

```
Setup of package 'telegram' ... integration 'telegram_bot' cannot be merged, expected a dict
```

Como el token sólo se puede cargar por la UI, vive en `/config/.storage` (en el
PVC), no en git — por eso **no** hay un Secret `ha-telegram`. En un PVC nuevo hay
que volver a agregar el bot a mano, como el resto de las config entries que HA se
guarda para sí (webOS, Broadlink, ESPHome).

### El contrato con la UI: `notify.telegram_casa`

El servicio viejo `notify.telegram` **también** quedó deprecado (HA lo avisa con
un *repair* y deja de funcionar en 2026.8.0). La forma actual es una **entidad
notify por chat id**, creada como *subentry* del config entry de Telegram, y
disparada con `notify.send_message`.

El `entity_id` sale del **título del subentry**, que lo pone quien lo crea en la
UI. O sea que hay un contrato que git no puede forzar: el subentry tiene que
llamarse **"Telegram casa"** para que quede `notify.telegram_casa`, que es lo que
referencian las automations. Si se le pone otro nombre, las alertas fallan en
silencio.

> `notify.send_message` acepta **sólo** `message` — no hay campo `title`. Por eso
> los mensajes llevan el título plegado adentro ("Gas bajo: el tubo está al…").

---

## 7. Validar cambios

```bash
esphome config esphome/mopeka-gas.yaml
helm lint charts/home-assistant
helm template t charts/home-assistant
helm template t charts/home-assistant --set telegram.enabled=false   # camino condicional
```

Los packages se propagan al mount del ConfigMap con el sync de ArgoCD, pero HA
los relee **al reiniciar el pod**.
