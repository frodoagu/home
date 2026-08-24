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
| `sensor.gas_altura_suave` | promedio móvil de 3 h de la anterior |
| `sensor.gas_restante` | **kg de gas en el tubo, líquido + vapor** (ver §3 y §5) — acá vive la única fórmula |
| `sensor.gas_nivel` | % = `kg / 45` — fuente de la verdad del cálculo, no es la que se muestra (§2.1) |
| `binary_sensor.gas_bajo` | `problem`, < 10 kg sostenido 2 h |

La cadena es `tank_level` → `gas_altura` → `gas_altura_suave` → `gas_restante` →
`gas_nivel` y `gas_bajo`. A `gas_altura` y `gas_altura_suave` tampoco hay que
asignarles área, por lo mismo que al resto de las entidades del package (§2.1,
punto 4).

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

Son decimales de presentación, no de exactitud: la lectura cruda de un mismo día
se mueve ±20-40 mm por el chapoteo (≈ 2-4 puntos de %), bastante más que el
0,09 % que vale un mm. El promedio móvil de §4 se lleva casi todo eso, pero las
constantes del envase (§3) siguen sin calibrar, así que los decimales no son
exactitud real.

---

## 3. Por qué "Universal" no da porcentaje solo, y qué constantes hacen falta

"Universal" significa que el sensor no asume la geometría del tanque: a
diferencia de otros Mopeka Pro pensados para tanques de forma conocida, éste
sólo publica la lectura cruda (`tank_level`, en mm). Los kg y el % se calculan
en `packages/gas.yaml`.

### `tank_level` es altura de líquido, no headspace

El Mopeka va pegado **abajo** del tubo y dispara el ultrasonido **hacia
arriba**, así que `tank_level` es la **altura de la columna de líquido sobre el
sensor** — más gas ⇒ lectura más grande. No es la distancia desde el tope del
tubo hasta la superficie. El tubo vacío es `0 mm`.

### De altura a kg: dos constantes del envase

La conversión no es una regla de tres sobre la altura, porque la altura se mueve
sola con la temperatura (§5). `gas_restante` calcula la **masa de las dos fases**:

```text
kg = rho_liq(T) × a × h  +  rho_vap(T) × (v_tubo − a × h)
```

y para eso hacen falta dos constantes del tubo, las dos **medibles**:

| Constante | Qué es | Valor actual | Estado |
|---|---|---|---|
| `a` | **sección** interna, m² — el área del círculo horizontal, convierte altura en volumen (`V_líquido = a × h`) | **0,0748** | **calibrada** contra un tubo lleno (ver abajo) |
| `v_tubo` | **volumen interno total**, m³ — el vapor ocupa `v_tubo − a × h` | **0,108** | sin calibrar; capacidad típica de un envase de 45 kg |

### Cómo se calibró `a`

El 23/08/2026 el sensor se pasó a un tubo lleno. Se registraron 80 lecturas en
las 19,6 h siguientes, con `reading_quality` llegando a 100 %; ajustando una
recta y extrapolando al momento del montaje (para descontar lo ya consumido) da
**1168 mm a 11 °C**. Despejando `a` de la ecuación con 45 kg:

```text
a = (45 − rho_vap(T) × v_tubo) / ((rho_liq(T) − rho_vap(T)) × h)
```

sale **0,0748 m²**, o sea **31 cm de diámetro equivalente** — unos 97 cm de
perímetro, verificable con una cinta. La cuenta cierra sola por otro lado: con
`v_tubo = 0,108` eso implica 1443 mm de altura interna y un llenado del 80,9 %,
que es justo el límite de llenado convencional del GLP.

`a` es **insensible a `v_tubo`**: moverlo entre 0,100 y 0,115 m³ corre `a` un
0,5 %, porque a tubo lleno el término de vapor casi no pesa. Donde `v_tubo` sí
manda es en el otro extremo — fija el piso de ~1,6 kg de vapor con altura 0 — así
que sigue valiendo la pena leerlo: los envases traen estampada la **capacidad de
agua en litros** en la cofia; dividir por 1000.

Están escritas dentro del `state` de `gas_restante`, en un solo lugar. Ajustadas
esas dos, el resto de la cadena sale solo: el % es `kg / 45`, y los umbrales de
aviso ya están en kg.

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

## 5. Temperatura: por qué se cuenta masa y no altura

El tubo tiene **dos** efectos térmicos, y apuntan para lados contrarios:

- **Dilatación del líquido.** El propano líquido se expande ~0,3 % por °C (unas
  diez veces más que el agua). Calentar sube el nivel sin que entre gas. Escala
  con la **altura de líquido**.
- **Condensación del vapor.** Enfriar baja la presión de saturación, parte del
  vapor se condensa y **sube** el nivel. Escala con el **volumen de vapor**, que
  crece a medida que el tubo se vacía.

Así que el signo depende de cuán lleno esté el tubo. Con la masa fija y las
constantes de §3, la altura que reportaría el sensor a tres temperaturas:

| masa real | 25 °C | 15 °C | 5 °C | recorrido | lo que diría un % por altura sola |
|---|---|---|---|---|---|
| 40 kg | 991 mm | 964 mm | 938 mm | 52 mm | 86,1 % .. 90,9 % |
| 24 kg | 570 mm | 561 mm | 550 mm | 20 mm | 50,5 % .. 52,3 % |
| 12 kg | 255 mm | 258 mm | 259 mm | 4 mm | 23,4 % .. 23,8 % |
| 5 kg | 71 mm | 82 mm | 89 mm | 18 mm | 6,5 % .. 8,2 % |

Con el tubo lleno manda la dilatación (calor ⇒ sube) y con el tubo casi vacío
manda la condensación (frío ⇒ sube); alrededor de 12 kg se cancelan y la altura
casi no se mueve. Un % calculado sobre la altura sola se corre hasta 4,8 puntos
por un swing de 20 °C, **sin que se haya consumido nada**.

### La corrección

Sumar las dos fases. Al condensarse, el gas pasa de un término al otro y el
total no se mueve; la dilatación se cancela sola porque `rho_liq` es función de
`T`:

```text
kg = rho_liq(T) × a × h  +  rho_vap(T) × (v_tubo − a × h)
```

Con correlaciones de propano saturado ajustadas a tabla con **menos de 1 % de
error entre 0 y 40 °C** (kg/m³, `T` en °C):

```text
rho_liq(T) = 528 − 1,5·T
rho_vap(T) = 10,8 + 0,27·T + 0,006·T²
```

| T | `rho_liq` modelo / tabla | `rho_vap` modelo / tabla |
|---|---|---|
| 0 °C | 528,0 / 528,6 | 10,8 / 10,8 |
| 10 °C | 513,0 / 517,0 | 14,1 / 14,1 |
| 20 °C | 498,0 / 500,5 | 18,6 / 18,6 |
| 40 °C | 468,0 / 467,4 | 31,2 / 31,2 |

Son de **propano**. Si el envase trajera mezcla con butano, `rho_liq` sube y
`rho_vap` baja bastante, y habría que reajustarlas.

### Dos consecuencias que hay que tener presentes

1. **Con altura 0 el modelo no da 0 kg**: quedan ~1,6 kg de vapor. Es gas real y
   se quema, así que contarlo es lo correcto, pero implica que `gas_nivel` tiene
   **piso en ~3,9 %** en vez de llegar a 0. Por eso los avisos de §6 están en
   **kg y no en %** (10 kg y 6 kg, que reproducen los puntos de aviso que daban
   el 20 % y el 10 % del cálculo por altura sola).
2. **Vaciado del todo el líquido, el modelo sobreestima**: asume vapor saturado,
   y sin líquido el vapor deja de estarlo a medida que se consume. Es académico
   — para entonces el sensor tampoco puede leer (§4).

### Qué se gana, medido

Sobre las estadísticas horarias de HA del 4 al 20 de agosto de 2026, quitándole
la tendencia de consumo con una mediana móvil de ±12 h, el coeficiente térmico
del valor reportado:

| tramo de altura | por altura sola | por masa |
|---|---|---|
| 450-600 mm | +0,12 %/°C | +0,10 %/°C |
| 300-450 mm | +0,31 %/°C | +0,26 %/°C |
| 200-300 mm | +0,01 %/°C | +0,01 %/°C |
| 100-200 mm | +0,02 %/°C | +0,03 %/°C |

Mejora, pero poco, y conviene decir por qué: **ese ajuste está contaminado**. Más
frío ⇒ más calefacción ⇒ más consumo, así que parte de lo que aparece como
"coeficiente térmico" es en realidad consumo correlacionado con la temperatura, y
eso ningún modelo físico lo saca. Además el tubo está en un lugar resguardado y
en esos 16 días la temperatura se movió apenas entre 7 y 17 °C. Donde el modelo
se nota de verdad es en el rango que la tabla de arriba muestra y estos datos no
tienen: swings grandes, y el tubo cerca del fondo. Desde el 23/08/2026 `a` está calibrada
contra un tubo lleno (§3), así que la escala también es real; `v_tubo` sigue
estimada y lo único que mueve es el piso de vapor.

## 6. Alertas por Telegram

Cuatro automations en `packages/gas.yaml`, todas contra
`notify.afuera_telegram_gateway_fede_a`:

| Automation | Dispara |
|---|---|
| `gas_aviso_bajo` | transición de `binary_sensor.gas_bajo` (< 10 kg por 2 h) |
| `gas_aviso_critico` | `sensor.gas_restante` < 6 kg por 2 h |
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
