# SmartShade

Sustav za pametno upravljanje roletama u hotelu. Centralna IoT platforma je **Home Assistant**.

## Arhitektura

```
ESP32 (Soba 101)        ──┐
                          ├──► MQTT broker ──► Home Assistant ──► Node.js (proxy) ──► Web aplikacija
Python simulator (102-111) ──┘
```

- **ESP32** i **Python simulator** šalju podatke senzora i stanje roletne na MQTT broker.
- **Home Assistant** prima MQTT poruke, kreira entitete i izvršava automatizacije (noćni mod, zaštita od oluje, itd.).
- **Node.js backend** je proxy između web aplikacije i Home Assistant REST API-ja.
- **Web aplikacija** prikazuje stanje iz HA i šalje naredbe prema HA.

## Postavljanje

### 1. Instaliraj ovisnosti

```bash
npm install
```

### 2. Konfiguriraj `.env`

```bash
cp .env.example .env
```

Uredi `.env`:

```env
HA_BASE_URL=https://tvoj-cloudflare-tunnel.trycloudflare.com
HA_TOKEN=tvoj_long_lived_access_token
```

Token se generira u HA: **Profil → Long-Lived Access Tokens → Create Token**

### 3. Pokretanje

```bash
npm start
```

- Stanar:       http://localhost:3000
- Administrator: http://localhost:3000/admin.html

### 4. Simulator virtualnih soba (opcionalno)

```bash
pip install paho-mqtt python-dotenv
python simulator/rooms_simulator.py
```

Simulator:
- Objavljuje MQTT Discovery konfiguracije → HA automatski kreira entitete za sobe 102-111
- Šalje podatke senzora svakih 5 sekundi
- Sluša naredbe za rolete koje dolaze iz HA (OPEN/CLOSE/STOP/set_position)
- **Ne odlučuje o automatizacijama** — to radi HA

## Home Assistant entiteti

Za svaku sobu postoje entiteti oblika (primjer za sobu 101, `device_id = smartshade_main`):

| Entitet | Opis |
|---------|------|
| `cover.smartshade_main_shade` | Roletna |
| `sensor.smartshade_main_temperature` | Temperatura |
| `sensor.smartshade_main_light` | Osvjetljenje |
| `sensor.smartshade_main_humidity` | Vlaga |
| `sensor.smartshade_main_wind` | Brzina vjetra |
| `binary_sensor.smartshade_main_rain` | Kiša |
| `select.smartshade_main_mode` | Mod (auto/manual) |
| `input_datetime.smartshade_main_morning_open_time` | Jutarnje otvaranje |
| `input_datetime.smartshade_main_night_closing_time` | Večernji/noćni raspored |

Za virtualne sobe: `device_id = smartshade_room_102`, `smartshade_room_103`, ...

## MQTT topici

```
smartshade/{home_id}/{room_id}/{shade_id}/temperature
smartshade/{home_id}/{room_id}/{shade_id}/humidity
smartshade/{home_id}/{room_id}/{shade_id}/light
smartshade/{home_id}/{room_id}/{shade_id}/weather/wind
smartshade/{home_id}/{room_id}/{shade_id}/weather/rain/state
smartshade/{home_id}/{room_id}/{shade_id}/cover/position
smartshade/{home_id}/{room_id}/{shade_id}/cover/command      ← HA → uređaj
smartshade/{home_id}/{room_id}/{shade_id}/cover/set_position ← HA → uređaj
smartshade/{home_id}/{room_id}/{shade_id}/mode/state
smartshade/{home_id}/{room_id}/{shade_id}/mode/set           ← HA → uređaj
smartshade/{home_id}/{room_id}/{shade_id}/availability
```

## Backend API

Backend proksira sve pozive prema Home Assistant REST API-ju:

| Metoda | Endpoint | Proxira prema HA |
|--------|----------|-----------------|
| GET | `/api/rooms` | GET `/api/states/{entity_id}` (za svaku sobu) |
| GET | `/api/rooms/:id` | GET `/api/states/{entity_id}` |
| POST | `/api/rooms/:id/command` | POST `/api/services/cover/...` ili `/api/services/select/...` |
| POST | `/api/rooms/:id/schedule` | POST `/api/services/input_datetime/set_datetime` |
| POST | `/api/admin/group` | POST `/api/services/cover/open_cover` ili `close_cover` |
| GET | `/api/admin/energy` | Izračunato iz HA stanja |
