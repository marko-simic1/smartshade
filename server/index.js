require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HA_BASE_URL = (process.env.HA_BASE_URL || 'http://localhost:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

// ws:// ili wss:// ovisno o http/https
const HA_WS_URL = HA_BASE_URL.replace(/^http/, 'ws') + '/api/websocket';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Korisnici ────────────────────────────────────────────────────────────────

const users = {
  admin:     { role: 'admin',    rooms: 'all' },
  stanar101: { role: 'resident', rooms: ['101'] },
  stanar102: { role: 'resident', rooms: ['102'] }
};

// ─── Konfiguracija soba ───────────────────────────────────────────────────────

const roomConfig = {};

[
  { id: '101', floor: 1, name: 'Soba 101', isPhysical: true,  deviceId: 'smartshade_main' }
].concat(
  Array.from({ length: 10 }, (_, i) => {
    const id = String(102 + i);
    return {
      id,
      floor: parseInt(id) <= 105 ? 1 : 2,
      name: `Soba ${id}`,
      isPhysical: false,
      deviceId: `smartshade_room_${id}`
    };
  })
).forEach(r => { roomConfig[r.id] = r; });

// Raspored se čuva lokalno (izvršava HA automatizacija)
const schedules = {};
Object.keys(roomConfig).forEach(id => {
  schedules[id] = { open: '07:00', close: '22:00' };
});

// ─── Entity ID helperi ────────────────────────────────────────────────────────

function getEntityIds(roomId) {
  const cfg = roomConfig[roomId];
  if (!cfg) return null;
  const d = cfg.deviceId;
  return {
    shade:       `cover.${d}_shade`,
    temperature: `sensor.${d}_temperature`,
    light:       `sensor.${d}_light`,
    humidity:    `sensor.${d}_humidity`,
    wind:        `sensor.${d}_wind`,
    rain:        `binary_sensor.${d}_rain`,
    mode:        `select.${d}_mode`
  };
}

// Reverse mapa: entityId → { roomId, field }
// Koristimo za instant cache update kad WebSocket donese event
const entityToRoom = {};
Object.keys(roomConfig).forEach(roomId => {
  const e = getEntityIds(roomId);
  entityToRoom[e.shade]       = { roomId, field: 'shade' };
  entityToRoom[e.temperature] = { roomId, field: 'temperature' };
  entityToRoom[e.light]       = { roomId, field: 'light' };
  entityToRoom[e.humidity]    = { roomId, field: 'humidity' };
  entityToRoom[e.wind]        = { roomId, field: 'wind' };
  entityToRoom[e.rain]        = { roomId, field: 'rain' };
  entityToRoom[e.mode]        = { roomId, field: 'mode' };
});

// ─── In-memory cache soba ─────────────────────────────────────────────────────

// Inicijalni prazan cache — puni se REST load-om na startu
const roomCache = {};
Object.keys(roomConfig).forEach(id => {
  const cfg = roomConfig[id];
  roomCache[id] = {
    id,
    name: cfg.name,
    floor: cfg.floor,
    isPhysical: cfg.isPhysical,
    online: false,
    position: 0,
    temperature: 0,
    light: 0,
    humidity: 0,
    windSpeed: 0,
    rain: false,
    mode: 'manual',
    lightPreference: 'medium',
    schedule: schedules[id]
  };
});

function getCachedRooms(roomIds = null) {
  const ids = roomIds || Object.keys(roomCache);
  return ids.map(id => ({ ...roomCache[id], schedule: schedules[id] })).filter(Boolean);
}

// Primijeni jedno stanje entiteta na cache
function applyEntityState(entityId, newState) {
  const mapping = entityToRoom[entityId];
  if (!mapping) return false;

  const { roomId, field } = mapping;
  const room = roomCache[roomId];
  if (!room) return false;

  const validState = newState &&
    newState.state !== 'unavailable' &&
    newState.state !== 'unknown';

  switch (field) {
    case 'shade':
      room.online   = validState;
      room.position = (validState && newState.attributes)
        ? (parseFloat(newState.attributes.current_position) ?? room.position)
        : room.position;
      break;
    case 'temperature':
      if (validState) room.temperature = parseFloat(newState.state) || 0;
      break;
    case 'light':
      if (validState) room.light = parseFloat(newState.state) || 0;
      break;
    case 'humidity':
      if (validState) room.humidity = parseFloat(newState.state) || 0;
      break;
    case 'wind':
      if (validState) room.windSpeed = parseFloat(newState.state) || 0;
      break;
    case 'rain':
      room.rain = validState ? newState.state === 'on' : false;
      break;
    case 'mode':
      if (validState) room.mode = newState.state;
      break;
    default:
      return false;
  }
  return true;
}

// ─── HA REST helpers ──────────────────────────────────────────────────────────

async function haFetch(urlPath, options = {}) {
  if (!HA_TOKEN) {
    console.warn('HA_TOKEN nije postavljen - provjeri .env datoteku');
    return null;
  }
  try {
    const res = await fetch(`${HA_BASE_URL}${urlPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      console.warn(`HA REST ${urlPath} => HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`HA REST greška (${urlPath}):`, e.message);
    return null;
  }
}

async function haCallService(domain, service, data) {
  return haFetch(`/api/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

// Početni REST load — puni cache iz HA za sve sobe
async function initialRestLoad() {
  console.log('Početni REST load stanja iz HA...');
  const loads = [];

  for (const roomId of Object.keys(roomConfig)) {
    const e = getEntityIds(roomId);
    for (const entityId of Object.values(e)) {
      loads.push(
        haFetch(`/api/states/${entityId}`)
          .then(state => {
            if (state) applyEntityState(entityId, state);
          })
          .catch(() => {})
      );
    }
  }

  await Promise.all(loads);
  console.log('REST load završen.');
}

// ─── HA WebSocket klijent ─────────────────────────────────────────────────────

let haWs = null;
let wsReconnectTimer = null;
let wsSubId = 1;

function connectHaWebSocket() {
  if (!HA_TOKEN) {
    console.warn('HA_TOKEN nije postavljen — WebSocket nije pokrenut.');
    return;
  }

  console.log(`Spajam HA WebSocket: ${HA_WS_URL}`);
  haWs = new WebSocket(HA_WS_URL);

  haWs.on('open', () => {
    console.log('HA WebSocket: spojen');
    clearTimeout(wsReconnectTimer);
  });

  haWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 1. HA traži autentikaciju
    if (msg.type === 'auth_required') {
      haWs.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      return;
    }

    // 2. Autentikacija uspješna — pretplati se na state_changed
    if (msg.type === 'auth_ok') {
      console.log(`HA WebSocket: autentificiran (HA ${msg.ha_version})`);
      haWs.send(JSON.stringify({
        id: wsSubId,
        type: 'subscribe_events',
        event_type: 'state_changed'
      }));
      return;
    }

    // 3. Auth nije prošla
    if (msg.type === 'auth_invalid') {
      console.error('HA WebSocket: neispravan token! Provjeri HA_TOKEN u .env');
      haWs.close();
      return;
    }

    // 4. Potvrda pretplate
    if (msg.type === 'result' && msg.id === wsSubId) {
      if (msg.success) {
        console.log('HA WebSocket: pretplaćen na state_changed evente');
      } else {
        console.error('HA WebSocket: pretplata nije uspjela', msg.error);
      }
      return;
    }

    // 5. Dolazi event promjene stanja
    if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const { entity_id, new_state } = msg.event.data;

      // Filtriraj samo SmartShade entitete
      if (!entity_id.match(/^(cover|sensor|binary_sensor|select)\.smartshade_/)) return;

      const changed = applyEntityState(entity_id, new_state);
      if (changed) {
        // Pošalji update svim browserima odmah
        io.emit('rooms-update', getCachedRooms());
      }
    }
  });

  haWs.on('close', (code, reason) => {
    console.warn(`HA WebSocket: veza prekinuta (${code}). Reconnect za 5s...`);
    scheduleReconnect();
  });

  haWs.on('error', (err) => {
    console.error('HA WebSocket greška:', err.message);
    // 'close' event će se okidati automatski, reconnect tamo
  });
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(async () => {
    console.log('HA WebSocket: pokušavam reconnect...');
    // REST refresh da cache bude sinkroniziran
    await initialRestLoad();
    io.emit('rooms-update', getCachedRooms());
    connectHaWebSocket();
  }, 5000);
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  const user = req.query.user || 'admin';
  const u = users[user];
  if (!u) return res.status(403).json({ error: 'Nepoznat korisnik' });

  const ids = u.rooms === 'all' ? null : u.rooms;
  res.json(getCachedRooms(ids));
});

app.get('/api/rooms/:id', (req, res) => {
  if (!roomConfig[req.params.id]) return res.status(404).json({ error: 'Soba nije pronađena' });
  const room = roomCache[req.params.id];
  res.json({ ...room, schedule: schedules[req.params.id] });
});

// Naredbe se i dalje šalju REST-om prema HA
app.post('/api/rooms/:id/command', async (req, res) => {
  if (!roomConfig[req.params.id]) return res.status(404).json({ error: 'Soba nije pronađena' });

  const e = getEntityIds(req.params.id);
  const { action, value } = req.body;

  try {
    switch (action) {
      case 'up':
        await haCallService('cover', 'open_cover', { entity_id: e.shade });
        break;
      case 'down':
        await haCallService('cover', 'close_cover', { entity_id: e.shade });
        break;
      case 'stop':
        await haCallService('cover', 'stop_cover', { entity_id: e.shade });
        break;
      case 'set_position':
        await haCallService('cover', 'set_cover_position', { entity_id: e.shade, position: value });
        break;
      case 'set_mode':
        await haCallService('select', 'select_option', { entity_id: e.mode, option: value });
        break;
      case 'set_light_preference': {
        const presetMap = { low: 'Low', medium: 'Medium', high: 'High' };
        await haCallService('input_select', 'select_option', {
          entity_id: 'input_select.light_preset',
          option: presetMap[value] || value
        });
        break;
      }
      default:
        return res.status(400).json({ error: 'Nepoznata naredba' });
    }

    // Odgovori odmah s trenutnim cache stanjem
    // WebSocket će donijeti ažurirano stanje čim HA procesira naredbu
    res.json({ ...roomCache[req.params.id], schedule: schedules[req.params.id] });
  } catch (err) {
    console.error('Command greška:', err);
    res.status(502).json({ error: 'Greška pri slanju naredbe u Home Assistant' });
  }
});

app.post('/api/rooms/:id/schedule', (req, res) => {
  if (!roomConfig[req.params.id]) return res.status(404).json({ error: 'Soba nije pronađena' });
  schedules[req.params.id] = { ...schedules[req.params.id], ...req.body };
  res.json({ id: req.params.id, schedule: schedules[req.params.id] });
});

app.post('/api/admin/group', async (req, res) => {
  const { action, floor } = req.body;
  const targets = Object.entries(roomConfig)
    .filter(([, cfg]) => !floor || cfg.floor === floor)
    .map(([id]) => getEntityIds(id).shade);

  const haAction = action === 'close_all' ? 'close_cover' : 'open_cover';
  try {
    await Promise.all(targets.map(entityId => haCallService('cover', haAction, { entity_id: entityId })));
    res.json({ success: true, affected: targets.length });
  } catch (e) {
    res.status(502).json({ error: 'Greška pri grupnom upravljanju' });
  }
});

app.get('/api/admin/energy', (req, res) => {
  const data = getCachedRooms().map(r => {
    const closedPercent = 100 - r.position;
    const savings = Math.round(closedPercent * 0.15 + (r.mode === 'auto' ? 10 : 0));
    return { id: r.id, name: r.name, savings, position: r.position };
  });
  const total = data.reduce((sum, d) => sum + d.savings, 0);
  res.json({ rooms: data, totalSavings: total });
});

app.get('/api/users', (req, res) => res.json(users));

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Novi browser klijent dobiva trenutni cache odmah
  socket.emit('rooms-update', getCachedRooms());
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`SmartShade web app: http://localhost:${PORT}`);
  console.log(`Home Assistant:     ${HA_BASE_URL}`);

  if (!HA_TOKEN) {
    console.warn('UPOZORENJE: HA_TOKEN nije postavljen! Provjeri .env datoteku.');
    return;
  }

  // 1. Učitaj početno stanje iz HA REST-a
  await initialRestLoad();

  // 2. Otvori WebSocket prema HA za live evente
  connectHaWebSocket();
});
