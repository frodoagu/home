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
                                                                    notify.afuera_telegram_gateway_fede_a
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
| `sensor.pro_check_universal_5343_tank_level` | **altura de líquido en mm** sobre el sensor (que va pegado abajo del tubo) — NO es un %, ver §3 |
| `sensor.pro_check_universal_5343_temperature` | temperatura del sensor — espejada como `sensor.gas_temperatura`, ver §2.1 |
| `sensor.pro_check_universal_5343_battery` | batería (CR2032), en % — confirmado contra el recorder de HA |
| `sensor.pro_check_universal_5343_reading_quality` | % de calidad del eco (no usado todavía por `packages/gas.yaml`, ver §4) |
| `sensor.pro_check_universal_5343_battery_voltage`, `_position_x`, `_position_y`, `_signal_strength` | expuestas por la integración pero sin consumidor en este package |

Y las derivadas, del package de HA:

| Entidad | Qué es |
|---|---|
| `sensor.gas_nivel` | % calculado a partir de `tank_level` (ver §3) |
| `sensor.gas_restante` | kg restantes (`% × 45`) |
| `sensor.gas_temperatura` | espejo de la temperatura del Mopeka (ver §2.1) |
| `binary_sensor.gas_bajo` | `problem`, < 20 % sostenido 2 h |

`sensor` ya está en `googleAssistant.exposedDomains`, así que el nivel también
queda disponible en Google Home sin tocar nada.

## 2.1 Por qué el package espeja la temperatura

La página del área agrupa **por dispositivo**: las entidades del Mopeka salen
bajo "Pro Check Universal 5343" y las del package, que no tienen dispositivo,
bajo "Otras" — o sea el gas partido en dos bloques.

No se arregla desde git: en HA 2026.7.1 `device_id` está sólo en el schema de
config entry de la integración `template`
(`TEMPLATE_ENTITY_COMMON_CONFIG_ENTRY_SCHEMA`), no en el de YAML, así que una
entidad de template declarada en un package **no se puede colgar de un
dispositivo** (ponerle `device_id:` es error de config). Y editar el
`device_id` a mano en `core.entity_registry` no sobrevive: `entity_platform`
reescribe el registry con `device_id=device.id if device else None` en cada
arranque.

Por eso el que se muda es el dato: `sensor.gas_temperatura` copia la lectura y
todo el gas queda junto. Del lado de HA (UI, no git) hay que sacar el
dispositivo del área — *Ajustes → Dispositivos → Pro Check Universal 5343 →
Área: ninguna* — así sus entidades dejan de aparecer en la página de Cocina, y
asignar a Cocina las derivadas que se quieran ver. El bloque sigue titulándose
"Otras" porque ese nombre lo pone HA; para un encabezado que diga "Gas" hay que
armar una sección propia en un dashboard.

La misma receta sirve para la batería (`_battery`) si se la quiere en el grupo
en vez de perderla junto con el dispositivo — el aviso de batería baja de §5 no
depende de eso, dispara contra la entidad de la integración.

---

## 3. Por qué "Universal" no da porcentaje solo, y cómo se calibra

"Universal" significa que el sensor no asume la geometría del tanque: a
diferencia de otros Mopeka Pro pensados para tanques de forma conocida, éste
sólo publica la lectura cruda (`tank_level`, en mm). El % y los kg se calculan
en `packages/gas.yaml`.

### `tank_level` es altura de líquido, no headspace

El Mopeka va pegado **abajo** del tubo y dispara el ultrasonido **hacia
arriba**, así que `tank_level` es la **altura de la columna de líquido sobre el
sensor** — más gas ⇒ lectura más grande. No es la distancia desde el tope del
tubo hasta la superficie. El tubo vacío es `0 mm`, así que hay **una sola**
constante:

```text
level% = clamp( tank_level / full_mm * 100, 0, 100)
```

| Constante | Valor actual | De dónde sale |
|---|---|---|
| `full_mm` | **1090** (`1280 × 0.85`) | altura de líquido con el tubo recién cargado: 1280 mm de alto útil de un tubo de 45 kg (dato de fabricante) × ~85 % de llenado — los envases de GLP no se cargan al 100 % del volumen (espacio de expansión de vapor), y 85 % es convención de industria, no un dato verificado para este tubo |

**Es un punto de partida, no una calibración real.** Para corregirlo: anotar el
`tank_level` en mm apenas carguen el tubo (recién cargado = lleno de verdad) y
reemplazar 1090 en **las tres** fórmulas de `packages/gas.yaml` (nivel, restante
y el umbral del `binary_sensor` están escritas independientes a propósito — no
encadenadas entre sí, para no depender del orden de inicialización de los
template sensors).

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
disponibles** en vez de reportar un tubo vacío.

El costo de esa guarda es que **un tubo realmente vacío también queda no
disponible** — no dispara `gas_bajo`, sólo `gas_aviso_sin_datos` a las 12 h. Se
acepta porque para cuando la lectura llega a `0` los avisos de 20 % y 10 % ya se
mandaron: el aviso temprano no depende de la guarda, y filtrar el `0` espurio sí
evita un falso "gas crítico".

Chequeando el recorder de HA directo (`states`/`states_meta` en
`home-assistant_v2.db`) con el sensor ya montado en el tubo real, `tank_level`
viene **estable en 584-586 mm** durante los primeros ~40 min — nada parecido al
0 constante del M1001. Sí hay ruido en `reading_quality` (llegó a `0` /
`unavailable` recién emparejado, después se estabilizó en 33-67 %), que
`packages/gas.yaml` todavía no usa. Si en el futuro `tank_level` empieza a
mostrar valores erráticos sin caer a 0, `reading_quality` es el candidato obvio
para sumar al `availability`.

---

## 5. Alertas por Telegram

Cuatro automations en `packages/gas.yaml`, todas contra
`notify.afuera_telegram_gateway_fede_a`:

| Automation | Dispara |
|---|---|
| `gas_aviso_bajo` | transición de `binary_sensor.gas_bajo` (< 20 % por 2 h) |
| `gas_aviso_critico` | `sensor.gas_nivel` < 10 % por 2 h |
| `gas_aviso_bateria_sensor` | batería del sensor < 15 % por 1 h |
| `gas_aviso_sin_datos` | 12 h sin lecturas (sensor fuera de rango, batería agotada, despegado) |

Las dos últimas existen para que el monitoreo **no se muera en silencio**: sin
ellas, el modo de falla es quedarse sin gas *y* sin aviso.

### El entity_id de Telegram no se elige, sale de datos de Telegram

Se configuró la integración desde cero en esta sesión (**Ajustes →
Dispositivos y servicios → Telegram Bot**, config entry "Agu Home", más un
subentry `allowed_chat_ids` para el chat propio). Verificado directo contra
`core.config_entries`/`core.entity_registry` en el pod, el resultado corrige
una idea equivocada que traía este documento (y que sigue en el historial del
PR #42): **el entity_id no sale de un título que uno tipea al crear el
subentry**. En esta versión, el subentry `allowed_chat_ids` ni siquiera pide un
título — su `title` se autocompleta con el nombre del contacto de Telegram (acá
salió "Fede A"), y el entity_id combina eso con el nombre propio del device del
bot (que sale de `getMe()` del lado de Telegram, acá "Afuera Telegram
Gateway" — probablemente el nombre con el que se registró el bot en BotFather
en algún momento anterior de este repo, no algo elegido en este flujo). El
resultado, sin haber tipeado ninguna de las dos partes:

```text
notify.afuera_telegram_gateway_fede_a
```

**Moraleja para la próxima vez que se toque esto:** no asumir el entity_id por
convención ni por lo que diga esta doc — confirmarlo en HA (Developer Tools →
States, filtrando `notify.`) después de crear el bot o agregar un chat, porque
tanto el nombre del bot como el del contacto vienen de Telegram, no de HA ni de
git.

Igual que documentado en [home-assistant.md](home-assistant.md): desde 2026.7
`telegram_bot` es `config_flow: true` (no se puede configurar por YAML) y
`notify.telegram` está deprecado. Se dispara con `notify.send_message`, que
sólo acepta `message` (no `title`) — por eso los títulos van plegados adentro
del mensaje.

---

## 6. Validar cambios

```bash
helm lint charts/home-assistant
helm template t charts/home-assistant
```

Los packages se propagan al mount del ConfigMap con el sync de ArgoCD, pero HA
los relee **al reiniciar el pod**.
