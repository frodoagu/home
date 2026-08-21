# Nivel del tubo de gas (Mopeka Pro Check Universal, Bluetooth nativo)

Monitoreo del nivel del **tubo de 45 kg** con un sensor ultrasónico **Mopeka Pro
Check Universal**, vía la integración **nativa `mopeka`** de Home Assistant —
sin ESP32 ni ESPHome de por medio.

| Pieza | Dónde vive |
|---|---|
| Config entry de Bluetooth/Mopeka | UI de HA (`.storage`, no está en git — ver [home-assistant.md](home-assistant.md#versioned-config-ha-packages)) |
| Sensores derivados + alertas | [`charts/home-assistant/packages/gas.yaml`](../charts/home-assistant/packages/gas.yaml) |

```
  Mopeka Pro Check Universal  ──BLE advertisement──>  ESP32 "BLE Proxy"  ──WiFi/API──>  Home Assistant
  (montado en el tubo)                                (esphome/ble-proxy.yaml)          integración nativa `mopeka`
                                                       reenvía, no decodifica            packages/gas.yaml
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

**El alcance BLE de la Pi no llega al tubo**, así que el advertisement entra por
un `bluetooth_proxy` de ESPHome en la cocina
([`esphome/ble-proxy.yaml`](../esphome/ble-proxy.yaml)) — mucho más simple que el
receptor del M1001, porque sólo **retransmite** el paquete
(`esp32_ble_tracker` + `bluetooth_proxy`, los dos en modo pasivo), no lo
decodifica. A diferencia del M1001, acá un proxy sí sirve, porque el parser que
finalmente decodifica es el mismo `mopeka-iot-ble` de HA y no algo corriendo en
el ESP32; el mismo proxy le sirve igual a los termómetros BTHome de la casa. Los
detalles de los dos proxies están en
[home-assistant.md](home-assistant.md#ble-proxies).

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
| `sensor.pro_check_universal_5343_temperature` | temperatura del sensor — es la que se muestra como "Temperatura", ver §2.1 |
| `sensor.pro_check_universal_5343_battery` | batería (CR2032), en % — confirmado contra el recorder de HA |
| `sensor.pro_check_universal_5343_reading_quality` | % de calidad del eco (no usado todavía por `packages/gas.yaml`, ver §4) |
| `sensor.pro_check_universal_5343_battery_voltage`, `_position_x`, `_position_y`, `_signal_strength` | expuestas por la integración pero sin consumidor en este package |

Y las derivadas, del package de HA:

| Entidad | Qué es |
|---|---|
| `sensor.gas_altura` | altura en mm con el eco doble descartado (ver §4) |
| `sensor.gas_altura_suave` | promedio móvil de 3 h de la anterior — de acá salen las tres derivadas |
| `sensor.gas_nivel` | % calculado a partir de la altura suavizada (ver §3) — fuente de la verdad del cálculo, no es la que se muestra (§2.1) |
| `sensor.gas_restante` | kg restantes (`% × 45`) |
| `binary_sensor.gas_bajo` | `problem`, < 20 % sostenido 2 h |

La cadena es `tank_level` → `gas_altura` → `gas_altura_suave` → las tres
derivadas. A `gas_altura` y `gas_altura_suave` tampoco hay que asignarles área,
por lo mismo que al resto de las entidades del package (§2.1, punto 4).

`sensor` ya está en `googleAssistant.exposedDomains`, así que el nivel también
queda disponible en Google Home sin tocar nada.

## 2.1 Cómo queda agrupado en el dashboard ("Gas", no "Otras")

El dashboard autogenerado (estrategia **home**) arma un grupo **por
dispositivo**: el encabezado es el nombre del dispositivo, las tarjetas usan
sólo la parte propia del nombre de cada entidad, y todo lo que **no** tiene
dispositivo cae en un único grupo titulado "Otras"
(`ui.panel.lovelace.strategy.home.others`). Ese título lo pone el frontend: no
hay agrupación por área ni por etiqueta, así que el nombre del grupo **es** el
nombre de un dispositivo o nada.

Y una entidad de template declarada en un package **no puede tener
dispositivo**: en HA 2026.7.1 `device_id` está sólo en el schema de config
entry de `template` (`TEMPLATE_ENTITY_COMMON_CONFIG_ENTRY_SCHEMA`), no en el de
YAML — ponerlo es error de config. Escribirlo a mano en `core.entity_registry`
tampoco sirve: `entity_platform` reescribe cada entidad al arrancar con
`device_id=device.id if device else None`.

De ahí el arreglo, todo del lado de HA (`.storage`, no git). Está aplicado; esto
es la receta para rehacerlo:

1. El **dispositivo Mopeka se renombra a "Gas"** (*Ajustes → Dispositivos*),
   `name_by_user`. Con eso el encabezado del grupo pasa a ser "Gas". Al
   renombrar, HA ofrece renombrar también los entity_id: **decir que no**, o el
   package se queda apuntando a `sensor.pro_check_universal_5343_*`
   inexistentes.
2. La temperatura de la integración se renombra a **"Temperatura"** — ya cuelga
   del dispositivo, no hace falta espejarla. Ojo: el nombre que se escribe
   reemplaza el `friendly_name` **entero**, no la mitad propia (queda
   "Temperatura", no "Gas Temperatura"), y la tarjeta muestra eso mismo.
3. El nivel se muestra con un **helper de plantilla** (*Ajustes → Dispositivos y
   servicios → Ayudantes → Plantilla → Sensor de plantilla*), llamado
   **"Nivel"**, dispositivo "Gas", estado `{{ states('sensor.gas_nivel') |
   float(0) }}`, unidad `%`, clase de estado medición, y en opciones avanzadas
   `availability: {{ states('sensor.gas_nivel') not in ['unknown',
   'unavailable'] }}`. Es un espejo de presentación: la fórmula, la calibración
   y las alertas siguen en `packages/gas.yaml`.

   A diferencia de las de YAML, estas entidades **sí** usan `has_entity_name`,
   así que el `friendly_name` se compone con el del dispositivo ("Gas Nivel")
   pero la tarjeta muestra sólo la parte propia ("Nivel"), y el entity_id se
   autogenera con área y dispositivo adelante (salió
   `sensor.cocina_gas_nivel`). Acá quedó renombrado a
   **`sensor.gas_nivel_espejo`** para que se lea qué es.
4. Las entidades del package no deben tener **área** asignada (*Ajustes →
   Entidades*), o reaparece el grupo "Otras" al lado del de "Gas".

Resultado: un solo grupo "Gas" con "Temperatura" y "Nivel". Nada de esto entra
en git (vive en `.storage`, como el emparejamiento) — de ahí que convenga tener
backups de HA andando.

Efecto colateral: `sensor.gas_nivel` y `sensor.gas_nivel_espejo` comparten
`friendly_name` ("Gas Nivel") y los dos guardan estadísticas. Si molesta en los
selectores, ocultar el del package (*Ajustes → Entidades → Ocultar*): las
automatizaciones lo siguen usando igual.

La batería no necesita tarjeta: la estrategia la muestra como badge en el
encabezado del grupo (toma la primera entidad con `device_class: battery` del
dispositivo).

### Decimales

`sensor.gas_nivel` redondea a 2 decimales **en el estado**, no en la UI: el
schema YAML de `template` no acepta `suggested_display_precision` (está sólo en
el de config entry), así que subir la precisión de la entidad desde *Ajustes →
Entidades* sobre un estado entero muestra `33,00 %` y nada más. El helper
"Nivel" espeja el estado tal cual, así que hereda los decimales (y tiene su
`display_precision` en 2 para que la tarjeta los muestre).

Son decimales de presentación, no de exactitud: la lectura de un mismo día se
mueve ±20-40 mm por el chapoteo (≈ 2-4 puntos de %), bastante más que el 0,09 %
que vale un mm.

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

## 4. Filtrado de lecturas

Dos lecturas malas distintas llegan a `tank_level`, y cada una tiene su guarda.

### El `0` espurio (heredado del M1001)

El M1001 tenía un gotcha específico: una lectura mala no daba "unavailable",
daba `distance = 0` — indistinguible de un tubo vacío, y hubiera disparado la
alerta con el tubo lleno. **No está confirmado que la integración nativa
`mopeka` tenga el mismo problema** (es un codebase Python completamente
distinto al `mopeka_std_check` de ESPHome), pero por las dudas la `condition`
del bloque trigger de `gas.yaml` sólo deja entrar lecturas `> 0`: un `0`, un
`unknown` o un `unavailable` no actualizan `gas_altura`, que retiene el último
valor bueno.

La contrapartida es que `gas_altura` **no se cae nunca** una vez que arrancó, así
que ya no sirve para detectar que el sensor dejó de reportar. Por eso
`gas_aviso_sin_datos` (§6) mira el sensor **crudo**, el único de la cadena que
efectivamente queda `unavailable` cuando dejan de llegar advertisements.

### El eco doble (cerca del fondo)

Con la columna de líquido corta, el eco directo llega débil y casi pegado al
ringdown del transductor, y el detector de picos se engancha al **segundo**
rebote (superficie → fondo → superficie): el sensor reporta **el doble** de la
altura real. Medido sobre el recorder de HA los días 20 y 21 de agosto de 2026,
con el tubo alrededor del 8 %:

| altura real (mm) | lectura espuria (mm) | ratio |
|---|---|---|
| 106-107 | 208 | 1,95 |
| 95-98 | 196-198 | 2,02 |
| 93-95 | 184-185 | 1,96 |
| 84-85 | 173-175 | 2,05 |

`reading_quality` acompaña — venía en 67-100 % del 11 al 19 de agosto y se
desplomó a 0-33 % cuando empezaron los dobles — pero **no alcanza como filtro**:
hay lecturas dobles con calidad 33 % y buenas con calidad 33 % también.

Lo que sí es determinante es el factor 2. `gas_altura` es un template
**trigger-based** que compara cada lectura contra su propio estado anterior
(`this.state`) y descarta los saltos hacia arriba de entre **1,4× y 3×**:

```text
altura = cruda   si  anterior >= 300 mm  o  cruda < anterior×1,4  o  cruda > anterior×3
         anterior  en cualquier otro caso
```

- **Bajar siempre se acepta**: el gas sólo se consume.
- **Subir hasta 1,4×** es chapoteo y deriva térmica (§5), no un eco doble.
- **Más de 3× es una recarga** (de 84 mm a ~1000 mm son 12×), así que entra
  derecho y el filtro no se queda pegado con el tubo lleno.
- **Arriba de 300 mm pasa todo**: ahí el eco directo domina y los dobles no
  aparecen. Eso también cierra el único hueco del criterio de recarga — cambiar
  el tubo estando a media carga sería un salto de ~2,5×, que caería en la banda
  descartada.

Simulado contra las 120 lecturas crudas posteriores al 20/08 15:00 UTC:
descarta 53 ecos dobles, bloquea 21 `unknown`, y la salida se queda en la banda
real de 84-109 mm en vez de saltar a 208.

Si arranca en frío (HA reiniciado, sin estado previo) la primera lectura entra
sin comparación posible y puede ser un doble, pero se corrige con la siguiente
buena: bajar siempre se acepta.

### El chapoteo

Consumir gas hace hervir el líquido y la superficie se mueve: la lectura de un
mismo día varía ±20-40 mm, unos 2-4 puntos de porcentaje — bastante más que el
0,09 % que vale un mm. `sensor.gas_altura_suave` es un `filter` con un
`time_simple_moving_average` de 3 h que se lleva ese ruido (y de paso el vaivén
térmico de §5). Las tres derivadas leen de ahí. La ventana no compromete las
alertas: contra los días de autonomía que quedan es corta, y `gas_bajo` y
`gas_aviso_critico` ya traen 2 h de debounce encima.

## 5. Temperatura: el nivel se mueve sin que cambie el gas

El tubo tiene **dos** efectos térmicos, y apuntan para lados contrarios:

- **Dilatación del líquido.** El GLP líquido se expande ~0,18 % por °C (unas
  diez veces más que el agua). Calentar sube el nivel sin que entre gas. El
  efecto es proporcional a la **altura de líquido**.
- **Condensación del vapor.** Enfriar baja la presión de saturación, parte del
  vapor se condensa y **sube** el nivel. Este es proporcional al **volumen de
  vapor**, que crece a medida que el tubo se vacía.

Así que el signo depende de cuán lleno esté: con el tubo lleno manda la
dilatación (calor ⇒ sube) y con el tubo casi vacío manda la condensación
(frío ⇒ sube). Medido sobre las estadísticas horarias de HA del 4 al 20 de
agosto de 2026, quitándole la tendencia de consumo con una mediana móvil de
±12 h:

| tramo de altura | dH/dT medido | n (horas) |
|---|---|---|
| 450-600 mm | +1,18 mm/°C | 122 |
| 380-450 mm | +2,83 mm/°C | 41 |
| 300-380 mm | +1,13 mm/°C | 52 |
| 200-300 mm | +0,57 mm/°C | 97 |
| 100-200 mm | +0,14 mm/°C | 67 |

El coeficiente **se achica monótonamente a medida que el tubo se vacía** y va
camino a cambiar de signo — que es exactamente lo que predice el modelo de los
dos términos. El valor absoluto del cruce no es confiable: sale de un ajuste
contaminado (más frío ⇒ más calefacción ⇒ más consumo, lo que sesga el
coeficiente hacia arriba) y el término de condensación depende de la sección del
tubo y del volumen total, dos constantes que **no están calibradas** (§3).

**La corrección exacta sería reportar masa en vez de altura**, sumando las dos
fases:

```text
kg = rho_liq(T) × A × h  +  rho_vap(T) × (V_tubo − A × h)
```

Al condensarse, el gas pasa de un término al otro y el total no se mueve; la
dilatación se cancela sola porque `rho_liq` es función de `T`. No está
implementado a propósito: hacen falta `A` y `V_tubo`, y lo que se gana (≤1 mm/°C,
menos de 0,1 % por °C) es **menos que el chapoteo** que ya filtra el promedio
móvil de §4. Si algún día se calibra el tubo de verdad, esta es la forma
correcta de hacerlo.

---

## 6. Alertas por Telegram

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

## 7. Validar cambios

```bash
helm lint charts/home-assistant
helm template t charts/home-assistant
```

Los packages se propagan al mount del ConfigMap con el sync de ArgoCD, pero HA
los relee **al reiniciar el pod**.
