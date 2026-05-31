require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HA_BASE_URL = (process.env.HA_BASE_URL || 'http://localhost:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const users = {
  admin: { role: 'admin', rooms: 'all' },
  stanar101: { role: 'resident', rooms: ['101'] },
  stanar102: { role: 'resident', rooms: ['102'] }
};

// Static room metadata + HA entity mapping
// Room 101 = physical ESP32 (device_id: smartshade_main, already configured in HA)
// Rooms 102-111 = virtual (simulator publishes MQTT Discovery, HA creates entities)
const roomConfig = {};

[
  { id: '101', floor: 1, name: 'Soba 101', isPhysical: true, deviceId: 'smartshade_main' }
].concat(
  Array.from({ length: 10 }, (_, i) => {
    const id = String(102 + i);
    return { id, floor: parseInt(id) <= 105 ? 1 : 2, name: `Soba ${id}`, isPhysical: false, deviceId: `smartshade_room_${id}` };
  })
).forEach(r => { roomConfig[r.id] = r; });

const schedules = {};
Object.keys(roomConfig).forEach(id => {
  schedules[id] = { open: '07:00', close: '22:00' };
});

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
      console.warn(`HA API ${urlPath} => HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error(`HA API greška (${urlPath}):`, e.message);
    return null;
  }
}

async function haGetState(entityId) {
  return haFetch(`/api/states/${entityId}`);
}

async function haCallService(domain, service, data) {
  return haFetch(`/api/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

async function getRoomFromHA(roomId) {
  const cfg = roomConfig[roomId];
  if (!cfg) return null;
  const e = getEntityIds(roomId);

  const [shade, temp, light, humidity, wind, rain, mode] = await Promise.all([
    haGetState(e.shade),
    haGetState(e.temperature),
    haGetState(e.light),
    haGetState(e.humidity),
    haGetState(e.wind),
    haGetState(e.rain),
    haGetState(e.mode)
  ]);

  const validState = (s) => s && s.state !== 'unavailable' && s.state !== 'unknown';
  const online = validState(shade);

  return {
    id: roomId,
    name: cfg.name,
    floor: cfg.floor,
    isPhysical: cfg.isPhysical,
    online,
    position: (shade && shade.attributes)
      ? (parseFloat(shade.attributes.current_position) ?? 0)
      : 0,
    temperature: validState(temp) ? (parseFloat(temp.state) || 0) : 0,
    light:       validState(light) ? (parseFloat(light.state) || 0) : 0,
    humidity:    validState(humidity) ? (parseFloat(humidity.state) || 0) : 0,
    windSpeed:   validState(wind) ? (parseFloat(wind.state) || 0) : 0,
    rain:        rain ? rain.state === 'on' : false,
    mode:        validState(mode) ? mode.state : 'manual',
    lightPreference: 'medium',
    schedule: schedules[roomId] || { open: '07:00', close: '22:00' }
  };
}

async function getAllRooms(roomIds = null) {
  const ids = roomIds || Object.keys(roomConfig);
  const results = await Promise.all(ids.map(id => getRoomFromHA(id)));
  return results.filter(Boolean);
}

function broadcastUpdate() {
  getAllRooms()
    .then(rooms => io.emit('rooms-update', rooms))
    .catch(e => console.error('broadcastUpdate greška:', e.message));
}

app.get('/api/rooms', async (req, res) => {
  const user = req.query.user || 'admin';
  const u = users[user];
  if (!u) return res.status(403).json({ error: 'Nepoznat korisnik' });

  try {
    const ids = u.rooms === 'all' ? null : u.rooms;
    const rooms = await getAllRooms(ids);
    res.json(rooms);
  } catch (e) {
    res.status(502).json({ error: 'Greška pri dohvatu podataka iz Home Assistanta' });
  }
});

app.get('/api/rooms/:id', async (req, res) => {
  if (!roomConfig[req.params.id]) return res.status(404).json({ error: 'Soba nije pronađena' });
  try {
    const room = await getRoomFromHA(req.params.id);
    res.json(room);
  } catch (e) {
    res.status(502).json({ error: 'Greška pri dohvatu podataka iz Home Assistanta' });
  }
});

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

    const room = await getRoomFromHA(req.params.id);
    broadcastUpdate();
    res.json(room);
  } catch (e) {
    console.error('Command greška:', e);
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
    broadcastUpdate();
    res.json({ success: true, affected: targets.length });
  } catch (e) {
    res.status(502).json({ error: 'Greška pri grupnom upravljanju' });
  }
});

app.get('/api/admin/energy', async (req, res) => {
  try {
    const rooms = await getAllRooms();
    const data = rooms.map(r => {
      const closedPercent = 100 - r.position;
      const savings = Math.round(closedPercent * 0.15 + (r.mode === 'auto' ? 10 : 0));
      return { id: r.id, name: r.name, savings, position: r.position };
    });
    const total = data.reduce((sum, d) => sum + d.savings, 0);
    res.json({ rooms: data, totalSavings: total });
  } catch (e) {
    res.status(502).json({ error: 'Greška pri dohvatu energetskih podataka' });
  }
});

app.get('/api/users', (req, res) => {
  res.json(users);
});

io.on('connection', (socket) => {
  getAllRooms()
    .then(rooms => socket.emit('rooms-update', rooms))
    .catch(console.error);
});

setInterval(broadcastUpdate, 5000);

server.listen(PORT, () => {
  console.log(`SmartShade web app: http://localhost:${PORT}`);
  console.log(`Home Assistant:     ${HA_BASE_URL}`);
  if (!HA_TOKEN) console.warn('UPOZORENJE: HA_TOKEN nije postavljen! Provjeri .env datoteku.');
});
