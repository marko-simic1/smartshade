# SmartShade

Adaptivni IoT sustav za upravljanje pametnim roletama — FER projekt, Internet stvari.

Sustav automatski prilagođava položaj roleta na temelju temperature, svjetlosti i vremenskih uvjeta. Korisnik može pratiti stanje i upravljati roletama preko web sučelja, uz podršku za automatski i ručni način rada.

## Tim

| Student | Uloga |
|---------|-------|
| Sandro Boka (voditelj) | IoT platforma |
| Marko Šimić | Mobilna/web aplikacija |
| Marko Subašić | IoT platforma |
| Teo Putarek | Uređaji (ESP32) |
| Vedran Kuzmanović | Uređaji (ESP32) |

## Arhitektura

```
ESP32 (Soba 101)  ──┐
                    ├── MQTT ──►  Web aplikacija (Node.js)
Python simulator  ──┘              ├── API + automatizacija
   (Sobe 102–111)                   ├── WebSocket (live podaci)
                                    └── Frontend (HTML/CSS/JS)
```

**Hijerarhija uređaja:** `Hotel_Zadar → Kat → Soba`

## Struktura projekta

```
projekt/
├── server/index.js              # Backend (Express, MQTT, Socket.io)
├── public/
│   ├── index.html               # Sučelje za stanara
│   ├── admin.html               # Sučelje za administratora
│   ├── css/style.css
│   └── js/app.js, admin.js
├── simulator/rooms_simulator.py   # Simulacija 10 virtualnih soba
├── firmware/esp32_smartshade/   # Arduino kod za ESP32
├── package.json
└── README.md
```

## Preduvjeti

- [Node.js](https://nodejs.org/) (v18+)
- [Python 3](https://www.python.org/) (za simulator, opcionalno)
- Arduino IDE + ESP32 board support (za firmware, opcionalno)

## Pokretanje web aplikacije

```bash
# Instalacija ovisnosti
npm install

# Pokretanje servera
npm start
```

Aplikacija je dostupna na:

- **Stanar:** http://localhost:3000
- **Administrator:** http://localhost:3000/admin.html

### MQTT mod (spajanje na stvarni broker)

Po defaultu aplikacija koristi ugrađenu simulaciju podataka. Za spajanje na MQTT broker:

```bash
# Windows PowerShell
$env:USE_MQTT="true"
$env:MQTT_URL="mqtt://test.mosquitto.org"
npm start
```

## Pokretanje simulatora (10 virtualnih soba)

```bash
pip install paho-mqtt
python simulator/rooms_simulator.py
```

Simulator šalje podatke za sobe 102–111 i u konzoli ispisuje reakcije na jak vjetar, npr.:

```
Soba 304: Roletne podignute zbog jakog vjetra (52 km/h)
```

## ESP32 firmware

Datoteka: `firmware/esp32_smartshade/esp32_smartshade.ino`

### Hardver

| Komponenta | GPIO pin |
|------------|----------|
| DHT22 (temp/vlaga) | 4 |
| LDR (svjetlost) | 34 |
| Servo motor | 13 |
| LED (status) | 2 |

Servo: **0° = 0% (zatvoreno)**, **180° = 100% (otvoreno)**

### WiFi Manager

ESP32 se prvi put podiže kao hotspot **SmartShade-Setup**. Spoji se mobitelom, unesi SSID i lozinku WiFi mreže, nakon čega se ESP32 restartira i automatski spaja.

### Potrebne Arduino biblioteke

- WiFiManager (tzapu)
- PubSubClient
- DHT sensor library
- ESP32Servo
- ArduinoJson

## Funkcionalnosti

### Sučelje za stanara

- Vizualna animacija rolete u postotcima (0–100%)
- Prikaz temperature, svjetlosti i vlage
- Tipke **Gore / Stop / Dolje** + slider za precizno podešavanje
- Prebacivanje **Auto / Ručno** načina rada
- Odabir optimalnog intenziteta svjetlosti: **Low / Medium / High**
- Vremenski raspored (npr. otvaranje u 07:00)
- **Smart Reminder** — obavijest kad je vani mrak, a rolete su dignute

### Sučelje za administratora

- Tablica svih uređaja s Online/Offline statusom
- Upozorenje kad senzor prestane slati podatke
- Grupno upravljanje (spusti/podigni sve, po katovima)
- Grafovi procjene uštede energije
- Upravljanje korisničkim dozvolama (tko vidi koje sobe)

### Automatizacija

| Uvjet | Akcija |
|-------|--------|
| Ljeto: toplo (>26°C) + jako sunce | Spusti rolete |
| Zima: hladno (<20°C) + sunce vani | Digni rolete |
| Noć (22:00–06:00) | Spusti rolete |
| Jak vjetar (>40 km/h) | Podigni/uvuci rolete |
| Raspored | Otvaranje/zatvaranje u zadano vrijeme |

## MQTT topici

```
smartshade/Hotel_Zadar/Kat_{kat}/Soba_{id}/telemetry   # ESP32 → server
smartshade/Hotel_Zadar/Kat_{kat}/Soba_{id}/command     # server → ESP32
```

**Telemetry payload:**
```json
{
  "temperature": 23.5,
  "humidity": 48.2,
  "light": 450,
  "position": 50,
  "mode": "auto"
}
```

## API (kratki pregled)

| Metoda | Endpoint | Opis |
|--------|----------|------|
| GET | `/api/rooms?user=admin` | Popis soba |
| POST | `/api/rooms/:id/command` | Naredba (up/down/stop/set_position/set_mode) |
| POST | `/api/rooms/:id/schedule` | Postavi raspored |
| POST | `/api/admin/group` | Grupna naredba (close_all/open_all) |
| GET | `/api/admin/energy` | Procjena uštede energije |

## IoT platforma

Preporučena platforma: **Home Assistant** (prema projektnoj prijavi).

Web aplikacija može raditi samostalno ili uz Home Assistant / ThingsBoard kao MQTT broker i dashboard.
