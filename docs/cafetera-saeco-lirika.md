# Integración DIY: Cafetera Saeco Lirika Black ↔ Home Assistant (ESP32 + ESPHome)

Guía completa para controlar y monitorear una **Saeco Lirika Black** desde Home
Assistant con un ESP32 100% custom: "apretar" los 5 botones vía optoacopladores (PC817) y
leer el color del backlight (verde/amarillo/rojo + encendido) con un sensor de
color I2C.

> Esta máquina es 220 V. **Todo lo de esta guía toca SOLO la placa de baja
> tensión (botones y display), nunca la red eléctrica ni la caldera.** Los
> optoacopladores aportan además aislación galvánica.

---

## 1. Objetivo y decisiones tomadas

| Decisión | Elección |
|---|---|
| Firmware | **ESPHome** (YAML, API nativa con HA, OTA) |
| Control de botones | ESP32 → **5 salidas** → optoacoplador PC817 "aprieta" cada botón (en paralelo con el botón físico) |
| Botones | 1) Café corto · 2) Café largo · 3) Encender/Apagar · 4) Vapor · 5) Agua para té |
| Tipo de botón | Independientes, contacto simple |
| Lectura de pantalla | **Sensor de color** del backlight → verde / amarillo / rojo **+** encendido/apagado por brillo |
| Alimentación | **Fuente USB 5 V** independiente (aislada) |
| Placa | **ESP32 DevKit WROOM-32** (38 pines, USB-C) — `board: esp32dev` |
| Herramientas disponibles | Soldador, multímetro, impresora 3D |

### Estados de la pantalla (colores del backlight)

El sensor solo ve el **color**; su significado es **ambiguo** (varias causas
comparten color), así que HA reporta el color y una interpretación con las causas
posibles. Los **transitorios** ayudan a desambiguar (ver §11).

| Color | Estado | Posibles causas |
| --- | --- | --- |
| 🟢 Verde | Operativa | Lista para hacer café **o** haciendo café |
| 🟡 Amarillo | Atención (operable / esperar / transición) | Calentando · sin café en grano · descalcificar · apagándose (lavado) |
| 🔴 Rojo | No operable | Sin agua · depósito de borra lleno |
| ⚫ Apagada | Sin backlight | Máquina apagada |

**Transitorios útiles para desambiguar:**

- **Sin granos de café:** primero se pone **rojo** y enseguida queda **amarillo**
  (transición 🔴→🟡).
- **Calentando:** **amarillo** apenas encendida, que pasa a **verde** al terminar
  (⚫/🟡→🟢).
- **Apagándose (lavado automático):** al apagar hace **amarillo** (enjuague) y
  termina en **apagada** (🟢→🟡→⚫). Se distingue de los otros amarillos porque
  ocurre justo después de apretar **power**.
- **Rojo persistente** (no pasa a amarillo) → sin agua o depósito de borra lleno.

---

## 2. Arquitectura

```
                 ┌──────────────────────────────────────────┐
                 │             Home Assistant (k3s)          │
                 │   Integración ESPHome (API, port 6053)    │
                 └───────────────▲──────────────────────────┘
                                 │ WiFi (API nativa ESPHome)
                 ┌───────────────┴──────────────────────────┐
                 │              ESP32 DevKit v1              │
                 │                                           │
   Fuente USB 5V─┤ USB                                       │
                 │                                           │
                 │  GPIO32 ─[220Ω]─► PC817 #1 ──┐            │
                 │  GPIO33 ─[220Ω]─► PC817 #2 ──┤            │
                 │  GPIO25 ─[220Ω]─► PC817 #3 ──┼─► pads     │  ┌──────────────┐
                 │  GPIO26 ─[220Ω]─► PC817 #4 ──┤  de los    │  │ Placa botones │
                 │  GPIO27 ─[220Ω]─► PC817 #5 ──┘  botones   ├─►│ Saeco Lirika  │
                 │                                           │  └──────────────┘
                 │  GPIO21 (SDA) ┐                           │
                 │  GPIO22 (SCL) ┴─ TCS34725 ─────────────┐  │  ┌──────────────┐
                 │  3V3 / GND ─────────────────────────── ┼──┼─►│  Backlight    │
                 └────────────────────────────────────────┘  │  │  del display  │
                                                              └──└──────────────┘
```

Los optos quedan **en paralelo con cada botón físico**, así el uso manual de
la cafetera sigue funcionando exactamente igual.

---

## 3. ⚠️ Caveats y cosas a verificar antes de soldar

1. **Voltaje de los botones — no hace falta el valor, sí la polaridad.** El PC817
   tiene salida a fototransistor (conduce en **una sola dirección**), así que hay
   que saber cuál de los 2 pads del botón es el **positivo** (colector). No te
   interesa el número de voltaje, solo el **signo**, y lo ves en la misma pasada
   en que identificás los pads (ver punto 2).
2. **Las 2 mediciones (rápidas) por botón, en un solo paso.** Con la máquina
   encendida y el multímetro tocando los 2 candidatos a pad:
   - **Continuidad / apretar:** si al apretar el botón marca ~0 Ω → son los pads
     correctos.
   - **VDC (polaridad):** en modo Voltios DC, el pad que da lectura **positiva**
     es el **+** → ahí va el **colector** del PC817; el otro es el **emisor**.

   Anotá, para cada uno de los 5 botones, el par de pads y cuál es el +.
   (Cada PC817 está aislado, así que no importa si los botones comparten masa.)
3. **Encender/Apagar puede requerir pulsación larga.** Empezá con un pulso corto;
   si tu modelo necesita mantener apretado, subí la duración del pulso (ver YAML,
   `on/off`).
4. **Café: start/stop.** En estas máquinas, un toque **inicia** la preparación y
   otro toque la **corta**. Tenelo en cuenta al automatizar (el botón en HA es un
   "toque", no un "servir X ml").
5. **Calor.** El interior de la Lirika se calienta. Si vas a montaje interno,
   ubicá la electrónica lejos de la caldera y aislá con kapton; el ESP32 y el
   sensor no deben cocinarse.
6. **Garantía / seguridad.** Abrir la máquina puede anular la garantía. Trabajá
   siempre **desenchufada** para el cableado; solo enchufá para las pruebas de
   color/encendido.
7. **Sensor de color: apagá su LED.** El TCS34725 trae un LED blanco que, si
   queda encendido, contamina la lectura del backlight. Hay que desactivarlo
   (pin LED a GND o cortar el jumper del módulo).
8. **Red HA↔ESP32.** HA corre en k3s. Para que la integración ESPHome funcione,
   el pod de HA tiene que **alcanzar la IP del ESP32 en la LAN por el puerto
   6053** (y mDNS para autodiscovery). Si HA no está en `hostNetwork`, quizás
   tengas que agregar el dispositivo por IP y verificar routing/mDNS. Verificar
   al integrar (ver §9).

---

## 4. Lista de compras (BOM)

| # | Ítem | Cant. | Notas |
|---|------|------:|-------|
| 1 | **ESP32 DevKit WROOM-32** (38 pines, USB-C) | 1 | El "NodeMCU ESP32 38 pines" típico. Solo usamos 7 GPIO |
| 2 | **Optoacoplador PC817** (o EL817 / LTV817) | 5 (+2 repuesto) | Baratísimo y fácil de conseguir. Respetar polaridad (§3) |
| 3 | Resistencia **220 Ω** 1/4 W | 5 (+extras) | Limita la corriente del LED del PC817 (~9 mA @3.3V) |
| 4 | Módulo **sensor de color TCS34725** (I2C) | 1 | Con filtro IR; leemos el color del backlight |
| 5 | Placa perforada (perfboard) o PCB chica | 1 | Para montar ESP32 + los 5 PC817 |
| 6 | Cable fino (AWG28–30) / ribbon para soldar a los pads | 1 rollo | Que llegue de la placa a los botones |
| 7 | Conectores desmontables (Dupont o JST-XH) | a gusto | Para poder desconectar el mazo sin desoldar |
| 8 | **Fuente USB 5 V** (cargador) + cable | 1 | Alimenta el ESP32 por su puerto USB |
| 9 | Termocontraíble surtido | 1 | Aislar empalmes |
| 10 | Estaño + flux | — | Ya lo tenés seguramente |
| 11 | Filamento para **soporte 3D del sensor** (+ caja opcional) | — | Bloquea luz ambiente sobre el sensor |
| 12 | Kapton / cinta doble faz | — | Fijar y aislar del calor |
| 13 | *(Opcional)* Capacitor cerámico 100 nF | 5 | Desacople por canal, si querés prolijidad |

**Sobre la polaridad del PC817.** Como su salida es un fototransistor, conduce
solo de **colector a emisor**. Por eso hay que conectar el **colector al pad +**
del botón (el que quedó positivo en la medición de §3) y el **emisor al pad −**.
Cuando el botón se "apreta", el transistor satura y deja ~0.2 V entre los pads —
suficiente para que la placa lo lea como pulsado. El consumo es despreciable (solo
drena la corriente de pull-up del botón), así que el PC817 va sobradísimo.

*¿No querés ni chequear la polaridad?* Poné un **puente rectificador** de 4 diodos
1N4148 en los pads y colgá el fototransistor del lado DC del puente: se vuelve
agnóstico a la polaridad. Contra: agrega ~1.2 V de caída, que en líneas de 3.3 V
puede quedar justo para registrar la pulsación. **Conviene más medir la polaridad**
(es una sola lectura por botón) y usar el PC817 pelado.

---

## 5. Mapa de pines del ESP32

| Función | GPIO | Nota |
|---|---|---|
| Botón: Café corto | **GPIO32** | salida a PC817 #1 |
| Botón: Café largo | **GPIO33** | salida a PC817 #2 |
| Botón: Encender/Apagar | **GPIO25** | salida a PC817 #3 |
| Botón: Vapor | **GPIO26** | salida a PC817 #4 |
| Botón: Agua para té | **GPIO27** | salida a PC817 #5 |
| I2C SDA (sensor color) | **GPIO21** | TCS34725 |
| I2C SCL (sensor color) | **GPIO22** | TCS34725 |
| 3V3 / GND | — | alimentación sensor + retorno de los LEDs |

> Todos son GPIO "seguros" (no son strapping pins), quedan en **bajo al bootear**
> → cero riesgo de apretar un botón solo al encender el ESP32. Evité 0/2/12/15
> (strapping) y 6–11 (flash).

**Placa:** este mapa vale para cualquier **ESP32-WROOM DevKit** (30 o 38 pines,
incluida la "NodeMCU ESP32 38 pines USB-C"); en ESPHome es `board: esp32dev`.
Solo se usan 7 GPIO, así que no importa el conteo de pines.

Si en cambio usás un **ESP32-C3 Super Mini** (más barato/chico), cambian los
números y en el YAML va `board: esp32-c3-devkitm-1`:

| Función | GPIO C3 |
| --- | --- |
| Café corto / largo / power / vapor / agua té | GPIO3 / 4 / 5 / 6 / 7 |
| I2C SDA / SCL | GPIO0 / GPIO1 |

(En el C3 evitá GPIO2, 8 y 9 que son strapping.)

---

## 6. Esquemáticos

### 6.1 Un canal de botón (repetir ×5)

```
   ESP32                        PC817
                          ┌──────────────────────┐
  GPIO32 ──[220Ω]─────────┤1 ánodo   colector 4  ├────── pad +  del botón
                          │   (LED interno)       │            (colector → +)
  GND ────────────────────┤2 cátodo   emisor  3  ├────── pad −  del botón
                          └──────────────────────┘
                            salida en PARALELO con el botón físico
```

- Lado **control** (aislado, lado ESP32): GPIO → 220 Ω → ánodo (pin 1); cátodo
  (pin 2) → GND. GPIO en alto = LED encendido = "botón apretado".
- Lado **salida** (lado máquina): **colector (pin 4) al pad +** del botón,
  **emisor (pin 3) al pad −**. Respetá esta polaridad (§3): al revés el
  fototransistor no conduce.
- Pinout PC817 estándar: **1 ánodo · 2 cátodo · 3 emisor · 4 colector**.
  EL817 y LTV817 son idénticos. Igual chequealo contra el datasheet del que
  consigas.

### 6.2 Sensor de color TCS34725 (I2C)

```
  ESP32 3V3   ──────── VIN (3.3V)
  ESP32 GND   ──────── GND
  ESP32 GPIO21 ─────── SDA
  ESP32 GPIO22 ─────── SCL
  módulo: pin "LED" ── GND     ← apaga el LED blanco del sensor (o cortá el jumper)
```

Dirección I2C por defecto: **0x29**.

### 6.3 Alimentación

```
  Cargador USB 5V ── cable USB ── puerto USB del ESP32 DevKit
```

El ESP32 alimenta el sensor por su pin 3V3 y los LEDs de los PC817 por los
GPIO (3.3 V). Un solo suministro, todo aislado de la máquina.

### 6.4 Disposición en el perfboard (vista superior)

Idea de armado: el ESP32 sobre zócalos hembra, una fila de 5 PC817, y a un borde
**un único conector de 10 vías** hacia los botones (J-BTN) más el del sensor (JS,
4 vías). Para sacar la placa (NodeMCU + optos) desenchufás esos dos conectores.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  JS ▸ [VIN][GND][SDA][SCL]  → 4 vías al TCS34725 (queda en la máquina) │
 │                                                                        │
 │   ┌────────────── ESP32 DevKit WROOM-32 (en zócalos) ─────────────┐    │
 │   │ 3V3  GND  G21  G22   G32  G33  G25  G26  G27   ... USB(5V) ◂── │    │
 │   └───┬────┬────┬────┬─────┬────┬────┬────┬────┬────────────────── ┘    │
 │      3V3  GND  SDA  SCL   │    │    │    │    │                         │
 │       │    │    └────┴──► JS   │    │    │    │    │                    │
 │       │    │                   │    │    │    │    │                    │
 │       │    │   G32─[220Ω]─┤PC817₁├── +/− → J-BTN 1,2  (café corto)      │
 │       │    │   G33─[220Ω]─┤PC817₂├── +/− → J-BTN 3,4  (café largo)      │
 │       │    │   G25─[220Ω]─┤PC817₃├── +/− → J-BTN 5,6  (power)           │
 │       │    │   G26─[220Ω]─┤PC817₄├── +/− → J-BTN 7,8  (vapor)           │
 │       │    │   G27─[220Ω]─┤PC817₅├── +/− → J-BTN 9,10  (agua té)        │
 │       │    └──────── riel GND común (cátodos pin 2 de los 5 optos) ─┘   │
 │       └───────────── riel 3V3 (solo alimenta el sensor) ──────────┘    │
 │                                                                        │
 │  J-BTN ▸ mazo único de 10 hilos a los pads (colector=pin4 → +, emisor=pin3 → −) │
 └──────────────────────────────────────────────────────────────────────┘
```

Detalle de un opto en la placa (PC817, muesca a la izquierda):

```
        GPIO ──[220Ω]──┐
                       │
                   ┌───┴───┐
        pin 1 ●────┤ o     ├──── pin 4  → colector → pad +  (→ J-BTN)
      (ánodo)      │ PC817 │
        pin 2 ●────┤       ├──── pin 3  → emisor   → pad −  (→ J-BTN)
      (cátodo)     └───────┘
          │
          └──► riel GND
```

**Tabla de conexiones (una fila por botón):**

| Opto | GPIO (vía 220 Ω → pin 1) | pin 2 | pin 4 (colector) | pin 3 (emisor) | J-BTN (+ / −) |
| --- | --- | --- | --- | --- | --- |
| PC817₁ | GPIO32 | GND | café corto **+** | café corto **−** | 1 / 2 |
| PC817₂ | GPIO33 | GND | café largo **+** | café largo **−** | 3 / 4 |
| PC817₃ | GPIO25 | GND | power **+** | power **−** | 5 / 6 |
| PC817₄ | GPIO26 | GND | vapor **+** | vapor **−** | 7 / 8 |
| PC817₅ | GPIO27 | GND | agua té **+** | agua té **−** | 9 / 10 |

**Conectores sugeridos:** 1× **JST-XH de 10 vías** (J-BTN, al mazo de botones) +
1× de 4 vías (JS, al sensor que queda en la máquina). Elegí uno **polarizado / con
traba** (el JST-XH entra de una sola forma) — la polaridad de los optos importa
(§3). La alimentación entra por el **USB** del ESP32 (no va a la ficha). Para
sacar la placa, desenchufás J-BTN y JS y listo.

> **Alternativas al JST-XH:** *bornera enchufable de 10 polos* (sin crimpar, a
> destornillador, rearmable) o *IDC 2×5 + cable ribbon* (termina los 10 hilos de
> un apretón). Evitá el **Dupont pelado**: no es confiablemente polarizado y acá
> la polaridad importa.
>
> El `+`/`−` de cada botón sale de la medición de polaridad de §3. Si te
> equivocaste de lado en un canal, ese botón "no responde": invertí ese par en el
> housing de J-BTN (o cruzá los 2 hilos en el pad) y listo.
>
> **¿Menos pines?** Si con el multímetro confirmás que los 5 botones comparten un
> terminal **común** (típico en teclados de membrana), podés atar los emisores a
> ese común y bajar a **6 vías** (5 señales + 1 común). Sin confirmarlo, quedate
> en 10.

---

## 7. Montaje del sensor de color

El backlight ilumina toda la pantalla (~6×3 cm), así que el sensor tiene margen.
Objetivo: que el TCS34725 **vea la luz del backlight y nada de luz ambiente**.

- **Mejor opción:** un soporte impreso en 3D que apoye el sensor **a ras del
  vidrio/bisel**, con una "capucha" opaca alrededor para tapar luz externa.
- **Alternativa:** ubicarlo **por detrás o al costado**, cerca de los LEDs del
  backlight, dentro de la carcasa (ahí adentro no entra luz ambiente).
- Dejá 3–5 mm entre sensor y superficie; muy pegado satura, muy lejos entra luz
  de afuera.
- Imprimí la capucha en filamento **oscuro/opaco** (no translúcido).

---

## 8. Firmware ESPHome

Guardá esto como `esphome/saeco-lirika.yaml` (ver §10 para versionarlo en el repo).

```yaml
substitutions:
  name: saeco-lirika
  friendly_name: "Cafetera Saeco"
  press_duration: "220ms"      # duración del "toque" de un botón
  power_press: "220ms"         # subir si Encender/Apagar necesita pulsación larga
  double_gap: "400ms"          # separación entre las 2 pulsaciones del café doble

esphome:
  name: ${name}
  friendly_name: ${friendly_name}

esp32:
  board: esp32dev
  framework:
    type: arduino

logger:

api:
  encryption:
    key: !secret api_key        # generá con: openssl rand -base64 32

ota:
  - platform: esphome
    password: !secret ota_password

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  ap:
    ssid: "Saeco-Fallback"
    password: !secret ap_password

captive_portal:

i2c:
  sda: GPIO21
  scl: GPIO22
  scan: true
  frequency: 100kHz

# ---------- Salidas a los optos PC817 (botones) ----------
output:
  - platform: gpio
    pin: GPIO32
    id: out_cafe_corto
  - platform: gpio
    pin: GPIO33
    id: out_cafe_largo
  - platform: gpio
    pin: GPIO25
    id: out_power
  - platform: gpio
    pin: GPIO26
    id: out_vapor
  - platform: gpio
    pin: GPIO27
    id: out_agua_te

button:
  - platform: template
    name: "Café corto"
    icon: "mdi:coffee"
    on_press:
      - output.turn_on: out_cafe_corto
      - delay: ${press_duration}
      - output.turn_off: out_cafe_corto

  - platform: template
    name: "Café largo"
    icon: "mdi:coffee-outline"
    on_press:
      - output.turn_on: out_cafe_largo
      - delay: ${press_duration}
      - output.turn_off: out_cafe_largo

  # Café doble = 2 pulsaciones seguidas del mismo botón (timing local en el ESP32)
  - platform: template
    name: "Doble café corto"
    icon: "mdi:coffee"
    on_press:
      - output.turn_on: out_cafe_corto
      - delay: ${press_duration}
      - output.turn_off: out_cafe_corto
      - delay: ${double_gap}
      - output.turn_on: out_cafe_corto
      - delay: ${press_duration}
      - output.turn_off: out_cafe_corto

  - platform: template
    name: "Doble café largo"
    icon: "mdi:coffee-outline"
    on_press:
      - output.turn_on: out_cafe_largo
      - delay: ${press_duration}
      - output.turn_off: out_cafe_largo
      - delay: ${double_gap}
      - output.turn_on: out_cafe_largo
      - delay: ${press_duration}
      - output.turn_off: out_cafe_largo

  - platform: template
    name: "Vapor"
    icon: "mdi:kettle-steam"
    on_press:
      - output.turn_on: out_vapor
      - delay: ${press_duration}
      - output.turn_off: out_vapor

  - platform: template
    name: "Agua para té"
    icon: "mdi:cup-water"
    on_press:
      - output.turn_on: out_agua_te
      - delay: ${press_duration}
      - output.turn_off: out_agua_te

  - platform: template
    name: "Encender / Apagar"
    icon: "mdi:power"
    on_press:
      - output.turn_on: out_power
      - delay: ${power_press}
      - output.turn_off: out_power

# ---------- Sensor de color del backlight ----------
sensor:
  - platform: tcs34725
    address: 0x29
    integration_time: 154ms
    gain: 16x
    update_interval: 2s
    red_channel:
      name: "Backlight R"
      id: bl_r
    green_channel:
      name: "Backlight G"
      id: bl_g
    blue_channel:
      name: "Backlight B"
      id: bl_b
    clear_channel:
      name: "Backlight clear"
      id: bl_clear
    illuminance:
      name: "Backlight brillo"
      id: bl_lux
    color_temperature:
      name: "Backlight temp color"

text_sensor:
  - platform: template
    name: "Estado cafetera"
    id: estado_cafetera
    icon: "mdi:coffee-maker"
    update_interval: 2s
    lambda: |-
      // --- CALIBRAR con lecturas reales (ver §9) ---
      const float LUX_ENCENDIDA = 20.0;   // umbral apagada/encendida
      if (id(bl_lux).state < LUX_ENCENDIDA) {
        return {"apagada"};
      }
      float r = id(bl_r).state;
      float g = id(bl_g).state;
      float b = id(bl_b).state;
      // Clasificación por dominancia de canal:
      if (g > r && g > b) {
        return {"verde"};                 // operación normal
      } else if (r > g && r > b) {
        return {"rojo"};                  // no operable
      } else if (r > b && g > b) {
        return {"amarillo"};              // warning, operable
      }
      return {"desconocido"};

binary_sensor:
  - platform: template
    name: "Cafetera encendida"
    id: cafetera_encendida
    device_class: power
    lambda: |-
      return id(bl_lux).state >= 20.0;    // mismo umbral que arriba
```

Y el `esphome/secrets.yaml` (NO se commitea — ver §10):

```yaml
wifi_ssid: "TU_SSID"
wifi_password: "TU_PASS"
api_key: "PEGÁ_ACÁ_LA_KEY"        # openssl rand -base64 32
ota_password: "UN_PASS_OTA"
ap_password: "UN_PASS_AP"
```

### Compilar y flashear

```bash
pip install esphome          # o usar el contenedor esphome/esphome
esphome run esphome/saeco-lirika.yaml   # 1ra vez por USB; después OTA por WiFi
```

---

## 9. Calibración del sensor de color

Los umbrales del lambda son un punto de partida; hay que ajustarlos a **tu**
backlight:

1. Flasheá y abrí los logs (`esphome logs esphome/saeco-lirika.yaml`) o mirá las
   entidades `Backlight R/G/B/brillo` en HA.
2. Llevá la cafetera a cada estado y anotá los valores:
   - **Apagada** → mirá `Backlight brillo` (lux). Poné `LUX_ENCENDIDA` a la mitad
     entre "apagada" y "encendida".
   - **Verde / Amarillo / Rojo** → anotá R, G, B en cada uno.
3. Si la regla de dominancia no separa bien (ej. amarillo vs verde), ajustá el
   lambda con los números reales (ej. amarillo = R alto **y** G alto **y** B bajo
   con umbrales concretos).
4. Re-flasheá por **OTA** (ya no necesitás el USB).

---

## 10. Versionado en este repo

Este repo es GitOps para el cluster; el firmware del ESP32 no se despliega en
k3s, pero **sí conviene versionar el YAML** acá:

```
esphome/
  saeco-lirika.yaml        # el config de arriba (se commitea)
  secrets.yaml             # WiFi/API/OTA (NO se commitea)
  secrets.yaml.example     # plantilla sin valores (se commitea)
```

Agregá a `.gitignore`:

```
esphome/secrets.yaml
```

Esto sigue el patrón del repo de **secrets fuera de banda** (como el resto de la
infra). El firmware se buildea/flashea con la CLI de `esphome` desde tu máquina;
HA lo descubre solo.

### Integrarlo a Home Assistant
1. En HA: **Ajustes → Dispositivos y servicios → ESPHome**. Debería
   autodescubrir `saeco-lirika` (mDNS). Si no, **agregar por IP** del ESP32.
2. Pegá la **API encryption key** (la misma del `secrets.yaml`).
3. Verificá reachability: el pod de HA (k3s) tiene que llegar a la IP del ESP32
   en el **puerto 6053** (ver caveat §3.8). Si no autodescubre, probá el agregado
   manual por IP y revisá mDNS/routing de la LAN hacia el pod.
4. Aparecen las entidades: 7 `button` (5 simples + Doble café corto/largo),
   `sensor` **Estado cafetera** (el color; los text_sensor de ESPHome viven en el
   dominio `sensor`), `binary_sensor` **Cafetera encendida**, y los sensores
   crudos de color.

---

## 11. Interpretación de colores y automatización

El sensor solo reporta el **color**. Para traducirlo a un motivo legible (y
aprovechar los transitorios de §1) agregá en HA un **sensor template
"trigger-based"** que reacciona a cada cambio de color y **recuerda la
transición** — así distingue "sin granos" (🔴→🟡) de "calentando" (⚫/🟡→🟢):

```yaml
# HA: configuration.yaml o un package (el chart home-assistant usa packages).
# Ajustá el entity_id del sensor de color al real de tu instalación (§12).
template:
  - trigger:
      - platform: state
        entity_id: sensor.cafetera_saeco_estado_cafetera
    sensor:
      - name: "Cafetera motivo"
        unique_id: cafetera_motivo
        icon: mdi:coffee-maker
        state: >
          {% set to = trigger.to_state.state %}
          {% set from = trigger.from_state.state
                        if trigger.from_state else 'unknown' %}
          {% set pwr = states.button.cafetera_saeco_encender_apagar %}
          {% set pwr_ago = (now() - pwr.last_changed).total_seconds()
                           if pwr is not none else 99999 %}
          {% if to == 'apagada' %} Apagada
          {% elif to == 'verde' %} Lista o haciendo café
          {% elif to == 'rojo' %} Sin agua o depósito de borra lleno
          {% elif from == 'rojo' and to == 'amarillo' %} Sin café en grano
          {% elif to == 'amarillo' and from in ['apagada', 'unknown'] %} Calentando
          {% elif to == 'amarillo' and pwr_ago < 90 %} Apagándose (lavado)
          {% elif to == 'amarillo' %} Sin granos o hay que descalcificar
          {% else %} Desconocido
          {% endif %}
```

> El sensor **mantiene** el último motivo hasta el próximo cambio de color (ej.
> "Sin café en grano" queda fijo mientras el backlight siga amarillo). Es una
> heurística: el color es la única señal real, así que el motivo se infiere de
> **cómo llegó** a ese color (la transición) y de si **recién apretaste power**
> (`pwr_ago` separa "calentando" y "apagándose" de los otros amarillos).
> **Límite:** si encendés/apagás la máquina **a mano** (no desde HA) no hay press
> que registrar, así que ese amarillo puede quedar rotulado como "sin granos /
> descalcificar" hasta que la pantalla se apague. (Si más adelante querés cubrir
> esto, se puede sensar también la pulsación física del botón de power — era la
> opción "controlar + leer presiones".)

Automatizaciones (una vez andando):

- 🔴 **Sin agua / borra llena:** cuando el color pasa a `rojo` y **se mantiene**
  (usá `for: "00:00:03"` para ignorar el rojo fugaz del "sin granos") →
  notificación "Cargá agua o vaciá la borra".
- 🫘 **Sin café en grano:** cuando `Cafetera motivo` = `Sin café en grano`
  (transición 🔴→🟡) → notificación "Se acabaron los granos".
- 🧽 **Descalcificar:** si queda `amarillo` mucho rato sin haber sido un "sin
  granos" reciente → recordatorio de descalcificar (heurística por tiempo).
- ☕ **Script "Preparar café":** si está `apagada`, apretá Encender, esperá a que
  el color sea `verde` (terminó de calentar) y recién ahí apretá Café corto/largo.
  El sensor de color hace de "listo para servir".
- 📊 **Contador de cafés:** incrementá un `counter` en cada press de café.
- 🗣️ **Google Assistant:** ya tenés la integración en el repo
  (`charts/home-assistant`, `docs/`); exponé el script → *"Ok Google, hacé un café"*.

### Script "Preparar café"

Enciende si hace falta, **espera a que el color sea verde** (listo) y recién ahí
sirve. Si no puede (rojo sostenido = sin agua/borra, o se queda amarillo = sin
granos/descalcificar), **avisa el motivo** en vez de apretar a ciegas.

```yaml
# HA: scripts.yaml o un package. Ajustá los entity_id a los reales (§10/§12)
# y reemplazá notify.notify por tu notificador (companion app, Telegram, etc.).
script:
  preparar_cafe:
    alias: Preparar café
    icon: mdi:coffee-to-go
    mode: single                 # no arranca dos preparaciones a la vez
    fields:
      tipo:
        description: "Tipo de café: corto o largo"
        default: corto
        selector:
          select:
            options: [corto, largo]
      cantidad:
        description: "1 (simple) o 2 (doble)"
        default: 1
        selector:
          number:
            min: 1
            max: 2
    variables:
      color: sensor.cafetera_saeco_estado_cafetera
      boton: >
        {% set base = 'cafe_largo' if tipo == 'largo' else 'cafe_corto' %}
        {{ ('button.cafetera_saeco_doble_' ~ base) if (cantidad | int) == 2
           else ('button.cafetera_saeco_' ~ base) }}
    sequence:
      # 1) Encender si está apagada y esperar a que arranque
      - if:
          - condition: state
            entity_id: sensor.cafetera_saeco_estado_cafetera
            state: apagada
        then:
          - action: button.press
            target:
              entity_id: button.cafetera_saeco_encender_apagar
          - wait_template: "{{ not is_state(color, 'apagada') }}"
            timeout: "00:00:20"

      # 2) Si aún no está lista, esperar a que se ponga verde
      #    (o rojo SOSTENIDO 5 s = problema real, no el flash de "sin granos")
      - if:
          - condition: not
            conditions:
              - condition: state
                entity_id: sensor.cafetera_saeco_estado_cafetera
                state: verde
        then:
          - wait_for_trigger:
              - platform: state
                entity_id: sensor.cafetera_saeco_estado_cafetera
                to: verde
              - platform: state
                entity_id: sensor.cafetera_saeco_estado_cafetera
                to: rojo
                for: "00:00:05"
            timeout: "00:02:30"
            continue_on_timeout: true

      # 3) Servir si está lista; si no, avisar el motivo
      - choose:
          - conditions: "{{ is_state(color, 'verde') }}"
            sequence:
              - action: button.press
                target:
                  entity_id: "{{ boton }}"
          - conditions: "{{ is_state(color, 'rojo') }}"
            sequence:
              - action: notify.notify
                data:
                  title: "Cafetera ☕"
                  message: "No puedo hacer café: {{ states('sensor.cafetera_motivo') }}."
        default:
          - action: notify.notify
            data:
              title: "Cafetera ☕"
              message: >
                La cafetera no llegó a estar lista
                ({{ states('sensor.cafetera_motivo') }}).
```

Notas:

- `mode: single` evita dos preparaciones simultáneas. `action:`/`target:` es la
  sintaxis actual (en HA viejo: `service:`/`entity_id:`).
- El **rojo sostenido 5 s** filtra el rojo fugaz del ciclo "sin granos", así no
  aborta por una falsa alarma.
- Ajustá el timeout de calentado (`00:02:30`) a lo que tarde tu máquina.
- Café **doble**: pasá `cantidad: 2` (el script usa los botones "Doble …" del
  ESP32, que hacen las 2 pulsaciones con timing local). Si no dispara el doble,
  ajustá `double_gap` en las `substitutions` del YAML de ESPHome.
- Para invocarlo desde el dashboard, agregá botones que llamen al script con el
  tipo (y opcionalmente la cantidad):

```yaml
- type: button
  name: Café corto
  icon: mdi:coffee-to-go
  tap_action:
    action: perform-action
    perform_action: script.preparar_cafe
    data:
      tipo: corto
      cantidad: 1
- type: button
  name: Doble café largo
  icon: mdi:coffee-to-go
  tap_action:
    action: perform-action
    perform_action: script.preparar_cafe
    data:
      tipo: largo
      cantidad: 2
```

---

## 12. Dashboard en Home Assistant

Un panel que replica la botonera de la Saeco, con el estado (color) arriba. Solo
usa cards **nativas** de HA (sin HACS).

> **Antes de pegar, verificá los `entity_id` reales.** El prefijo depende del
> *friendly_name* del dispositivo (`Cafetera Saeco` → `cafetera_saeco_…`) y de tu
> versión de HA. Confirmalos en **Ajustes → Dispositivos → Cafetera Saeco** o en
> **Herramientas de desarrollo → Estados**, y reemplazá el prefijo si difiere.
> Ojo: los `text_sensor`/sensores de ESPHome viven en el dominio **`sensor.`**.

Cómo cargarlo: **Ajustes → Paneles → Agregar panel → (nuevo) →** botón editar
(lápiz) **→ menú ⋮ → Editar en YAML** y pegá:

```yaml
title: Cafetera
views:
  - title: Cafetera
    path: cafetera
    icon: mdi:coffee-maker
    cards:
      - type: vertical-stack
        cards:
          # ---- Estado (color del backlight) ----
          - type: markdown
            content: |
              {% set s = states('sensor.cafetera_saeco_estado_cafetera') %}
              {% set dot = {'verde':'🟢','amarillo':'🟡','rojo':'🔴','apagada':'⚫'}.get(s, '⚪') %}
              # {{ dot }} {{ s | capitalize }}
              ### {{ states('sensor.cafetera_motivo') }}

          # ---- Bebidas (2×2, como la máquina) ----
          - type: grid
            columns: 2
            square: true
            cards:
              - type: button
                name: Café corto
                icon: mdi:coffee
                show_state: false
                entity: button.cafetera_saeco_cafe_corto
                tap_action:
                  action: perform-action
                  perform_action: button.press
                  target:
                    entity_id: button.cafetera_saeco_cafe_corto
              - type: button
                name: Café largo
                icon: mdi:coffee-outline
                show_state: false
                entity: button.cafetera_saeco_cafe_largo
                tap_action:
                  action: perform-action
                  perform_action: button.press
                  target:
                    entity_id: button.cafetera_saeco_cafe_largo
              - type: button
                name: Vapor
                icon: mdi:kettle-steam
                show_state: false
                entity: button.cafetera_saeco_vapor
                tap_action:
                  action: perform-action
                  perform_action: button.press
                  target:
                    entity_id: button.cafetera_saeco_vapor
              - type: button
                name: Agua para té
                icon: mdi:cup-water
                show_state: false
                entity: button.cafetera_saeco_agua_para_te
                tap_action:
                  action: perform-action
                  perform_action: button.press
                  target:
                    entity_id: button.cafetera_saeco_agua_para_te

          # ---- Encendido (ancho completo) ----
          - type: button
            name: Encender / Apagar
            icon: mdi:power
            show_state: false
            entity: button.cafetera_saeco_encender_apagar
            tap_action:
              action: perform-action
              perform_action: button.press
              target:
                entity_id: button.cafetera_saeco_encender_apagar

          # ---- Diagnóstico / calibración (colapsable) ----
          - type: entities
            title: Diagnóstico
            show_header_toggle: false
            entities:
              - entity: binary_sensor.cafetera_saeco_cafetera_encendida
              - entity: sensor.cafetera_saeco_backlight_brillo
              - entity: sensor.cafetera_saeco_backlight_r
              - entity: sensor.cafetera_saeco_backlight_g
              - entity: sensor.cafetera_saeco_backlight_b
```

Notas:

- `action: perform-action` / `perform_action:` es la sintaxis actual (HA 2024.8+).
  En versiones viejas es `action: call-service` / `service: button.press`.
- La card `markdown` muestra el estado con un emoji de color (🟢🟡🔴⚫) que sale
  del sensor `estado_cafetera`, sin necesitar CSS ni cards custom.
- El bloque **Diagnóstico** te sirve para la calibración del color (§9); podés
  borrarlo después.

### Variante "sobre la foto de la máquina" (opcional)

Si querés que sea literal una plantilla sobre la máquina, sacale una foto de
frente, subila a `config/www/saeco.jpg` y usá una card **picture-elements** con
los botones posicionados encima:

```yaml
- type: picture-elements
  image: /local/saeco.jpg
  elements:
    - type: icon
      icon: mdi:coffee
      title: Café corto
      style: {top: 40%, left: 30%}
      tap_action:
        action: perform-action
        perform_action: button.press
        target: {entity_id: button.cafetera_saeco_cafe_corto}
    # … repetí para cada botón ajustando top/left sobre la foto …
    - type: state-label
      entity: sensor.cafetera_saeco_estado_cafetera
      style: {top: 10%, left: 50%}
```

### Versionarlo en el repo

Si querés versionar el dashboard, guardalo como
`home-assistant/dashboards/cafetera.yaml` y referencialo desde la config de HA
(modo YAML de Lovelace), siguiendo el patrón de secrets fuera de banda del repo.

---

## 13. Checklist de armado

- [ ] Identificar los 2 pads de cada botón **y su polaridad** (continuidad + VDC, §3).
- [ ] Conseguir BOM (§4): los 5 PC817, resistencias de 220 Ω, sensor y placa.
- [ ] Armar la placa: ESP32 + 5×(220 Ω + PC817) + zócalos para el mazo.
- [ ] Cablear cada PC817 **en paralelo** al botón, con el **colector al pad +**.
- [ ] Montar el TCS34725 sobre/detrás del backlight, con capucha 3D, LED apagado.
- [ ] Flashear `saeco-lirika.yaml` por USB.
- [ ] Integrar en HA y probar los 5 botones (con la máquina desenchufada primero,
      verificando continuidad; después enchufada).
- [ ] Calibrar umbrales de color (§9), re-flashear por OTA.
- [ ] Decidir montaje (interno vs caja externa) y cerrar todo, aislando del calor.
- [ ] Versionar `esphome/saeco-lirika.yaml` + `.gitignore` del secrets.
```
