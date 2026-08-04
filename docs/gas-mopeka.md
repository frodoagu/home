# Nivel del tubo de gas (Mopeka Pro Check Universal, Bluetooth nativo)

Monitoreo del nivel del **tubo de 45 kg** con un sensor ultrasónico **Mopeka Pro
Check Universal**, vía la integración **nativa `mopeka`** de Home Assistant —
sin ESP32 ni ESPHome de por medio.

| Pieza | Dónde vive |
|---|---|
| Config entry de Bluetooth/Mopeka | UI de HA (`.storage`, no está en git — ver [home-assistant.md](home-assistant.md#versioned-config-ha-packages)) |
| Sensores derivados + alertas | [`charts/home-assistant/packages/gas.yaml`](../charts/home-assistant/packages/gas.yaml) |

```
  Mopeka Pro Check Universal  ──BLE advertisement──>  Bluetooth del host (Pi)  ──D-Bus──>  Home Assistant
  (montado en el tubo)          integración nativa `mopeka`                                packages/gas.yaml
                                                                                                   │
                                                                                             notify.telegram_casa
```

---

## 1. Por qué esta vez NO hace falta ESPHome

Este repo ya tuvo un intento con un **Mopeka M1001** ("Standard Check") que se
revirtió (PR #41 → fix #42 → revert #43): la integración `mopeka` de HA
directamente no lo soporta (el parser [`mopeka-iot-ble`](https://github.com/Bluetooth-Devices/mopeka-iot-ble)
sólo conoce model bytes de la familia **Pro** y exige el Pro service UUID), así
que hubo que decodificar el advertisement a mano en un ESP32 con la plataforma
`mopeka_std_check` de ESPHome. Ese intento se devolvió porque, ya montado en el
tubo real, el sensor reportaba sistemáticamente 0 ecos (`Poor read quality.
Setting distance to 0.`) — algo del sensor o del acople, no de la config.

El **Pro Check Universal SÍ es de la familia que `mopeka-iot-ble` decodifica**:
está en su tabla `DEVICE_TYPES` como `0xC`. Por eso alcanza con la integración
nativa de Bluetooth de HA — el chart ya la tiene habilitada (`hostNetwork: true`
+ mount del D-Bus del host + `NET_ADMIN`/`NET_RAW` en
[`values.yaml`](../charts/home-assistant/values.yaml), ver
[home-assistant.md](home-assistant.md#bluetooth)) y no se tocó nada de eso para
este sensor.

**Si el alcance BLE de la Pi no le llega al tubo** (el escenario que en su
momento no hizo falta explorar): la alternativa es un `bluetooth_proxy` de
ESPHome cerca del tubo — mucho más simple que el receptor del M1001, porque sólo
tiene que **retransmitir** advertisements (`esp32_ble_tracker` +
`bluetooth_proxy: { active: true }`), no decodificarlos. A diferencia del M1001,
acá un proxy sí sirve, porque el parser que finalmente decodifica el paquete es
el mismo `mopeka-iot-ble` de HA, no algo corriendo en el ESP32.

### Emparejamiento

No está en git — como toda config entry que HA guarda en `.storage` (webOS,
Broadlink, ESPHome). Con el sensor montado en el tubo y dentro de alcance, HA lo
descubre solo por Bluetooth pasivo y aparece un discovery en *Ajustes →
Dispositivos y servicios*; si no aparece solo, se puede agregar a mano buscando
"Mopeka". El dispositivo quedó identificado como **"Pro Check Universal 5343"**.

---

## 2. Entidades

Las publica la integración nativa (prefijo `pro_check_universal_5343_`, del
nombre del dispositivo):

| Entidad | Qué es |
|---|---|
| `sensor.pro_check_universal_5343_tank_level` | **distancia cruda en mm** (sensor → superficie) — NO es un %, ver §3 |
| `sensor.pro_check_universal_5343_temperature` | temperatura del sensor |
| `sensor.pro_check_universal_5343_battery` | batería (CR2032), en % — nombre inferido por el mismo prefijo, **confirmar en HA** |

Y las derivadas, del package de HA:

| Entidad | Qué es |
|---|---|
| `sensor.gas_nivel` | % calculado a partir de `tank_level` (ver §3) |
| `sensor.gas_restante` | kg restantes (`% × 45`) |
| `binary_sensor.gas_bajo` | `problem`, < 20 % sostenido 2 h |

`sensor` ya está en `googleAssistant.exposedDomains`, así que el nivel también
queda disponible en Google Home sin tocar nada.

---

## 3. Por qué "Universal" no da porcentaje solo, y cómo se calibra

"Universal" significa que el sensor no asume la geometría del tanque: a
diferencia de otros Mopeka Pro pensados para tanques de forma conocida, éste
sólo publica la **distancia cruda** (`tank_level`, en mm). El % y los kg se
calculan en `packages/gas.yaml` con dos constantes:

```
level% = clamp( (empty_mm - tank_level) / (empty_mm - full_mm) * 100, 0, 100)
```

| Constante | Valor actual | De dónde sale |
|---|---|---|
| `empty_mm` | **1280** | altura total de un tubo de 45 kg (dato de fabricante) — no se restó el offset real de montaje del sensor porque no se midió a mano |
| `full_mm` | **190** (`1280 × 0.15`) | los envases de GLP no se cargan al 100 % del volumen (espacio de expansión de vapor); 15 % es convención de industria, no un dato verificado para este tubo |

**Son un punto de partida, no una calibración real.** Para corregir `full_mm`:
anotar el `tank_level` en mm apenas carguen el tubo (recién cargado = lleno de
verdad) y reemplazar el valor en **las dos** fórmulas de `packages/gas.yaml`
(nivel y restante están escritas independientes a propósito — no encadenadas
entre sí, para no depender del orden de inicialización de los template
sensors). `empty_mm` sólo se podría corregir si el tubo llegara a vaciarse del
todo con el sensor puesto y se registrara esa lectura.

Es lineal sobre el %, así que `sensor.gas_restante` hereda la exactitud del
`level`, calibración incluida.

---

## 4. Precaución heredada del M1001

El M1001 tenía un gotcha específico: una lectura mala no daba "unavailable",
daba `distance = 0` — indistinguible de un tubo vacío, y hubiera disparado la
alerta con el tubo lleno. **No está confirmado que la integración nativa
`mopeka` tenga el mismo problema** (es un codebase Python completamente
distinto al `mopeka_std_check` de ESPHome), pero por las dudas
`packages/gas.yaml` mantiene la misma defensa: todas las entidades derivadas
cuelgan de `tank_level > 0`, así que con una lectura de `0` mm se marcan **no
disponibles** en vez de reportar "tubo lleno" (que es justo lo que daría la
fórmula del §3 si se tomara ese `0` en serio).

---

## 5. Alertas por Telegram

Cuatro automations en `packages/gas.yaml`, todas contra `notify.telegram_casa`:

| Automation | Dispara |
|---|---|
| `gas_aviso_bajo` | transición de `binary_sensor.gas_bajo` (< 20 % por 2 h) |
| `gas_aviso_critico` | `sensor.gas_nivel` < 10 % por 2 h |
| `gas_aviso_bateria_sensor` | batería del sensor < 15 % por 1 h |
| `gas_aviso_sin_datos` | 12 h sin lecturas (sensor fuera de rango, batería agotada, despegado) |

Las dos últimas existen para que el monitoreo **no se muera en silencio**: sin
ellas, el modo de falla es quedarse sin gas *y* sin aviso.

### El contrato con la UI: `notify.telegram_casa`

Igual que documentado en [home-assistant.md](home-assistant.md): desde 2026.7
`telegram_bot` es `config_flow: true` (no se puede configurar por YAML) y
`notify.telegram` está deprecado. La forma actual es una entidad notify por chat
id, creada como *subentry* del config entry de Telegram, disparada con
`notify.send_message` (que sólo acepta `message`, no `title` — por eso los
títulos van plegados adentro del mensaje). El subentry tiene que seguir
llamándose **"Telegram casa"** para que el entity_id quede `notify.telegram_casa`
— si no existe o se renombró, estas automations fallan en silencio. Esto ya
estaba configurado desde el PR #42; no se tocó nada de ese lado para este sensor.

---

## 6. Validar cambios

```bash
helm lint charts/home-assistant
helm template t charts/home-assistant
```

Los packages se propagan al mount del ConfigMap con el sync de ArgoCD, pero HA
los relee **al reiniciar el pod**.
