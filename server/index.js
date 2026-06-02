require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { discoverPhysicalRooms } = require('./haDiscovery');
const {
  applyEntityState,
  buildVirtualRoomConfigs,
  getCachedRooms,
  getConfiguredRoomIds,
  getEntityIds,
  getGroupShadeTargets,
  getPhysicalRoomConfigs,
  hasRoom,
  initializeVirtualRooms,
  replaceRoomConfig,
  updateSchedule
} = require('./roomStore');

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

// ─── Sobe ─────────────────────────────────────────────────────────────────────
// Fizički uređaji se otkrivaju iz Home Assistanta, virtualne sobe ostaju iz simulatora.

initializeVirtualRooms();

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

// ─── HA registry discovery za fizičke uređaje ────────────────────────────────

async function refreshRoomConfigFromHa() {
  const virtualRooms = buildVirtualRoomConfigs();
  const currentPhysicalRooms = getPhysicalRoomConfigs();

  try {
    const physicalRooms = await discoverPhysicalRooms({
      haWsUrl: HA_WS_URL,
      haToken: HA_TOKEN
    });
    replaceRoomConfig([...physicalRooms, ...virtualRooms]);
    console.log(`HA discovery: ${physicalRooms.length} fizičkih SmartShade uređaja, ${virtualRooms.length} virtualnih soba.`);

    // Ažuriraj korisničke dozvole za fizičke sobe
    // stanar101 dobiva pristup prvoj fizičkoj sobi koju HA discovery pronađe
    if (physicalRooms.length > 0) {
      users.stanar101.rooms = [physicalRooms[0].id];
      console.log(`stanar101 → pristup sobi: ${physicalRooms[0].id} (${physicalRooms[0].name})`);
    }
  } catch (err) {
    replaceRoomConfig([...currentPhysicalRooms, ...virtualRooms]);
    console.warn('HA discovery nije uspio, zadržavam postojeću konfiguraciju:', err.message);
  }
}

// Početni REST load — puni cache iz HA za sve sobe
async function initialRestLoad() {
  console.log('Početni REST load stanja iz HA...');
  const loads = [];

  for (const roomId of getConfiguredRoomIds()) {
    const e = getEntityIds(roomId);
    for (const entityId of Object.values(e || {})) {
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
    // Registry + REST refresh da cache bude sinkroniziran
    await refreshRoomConfigFromHa();
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

  if (u.rooms === 'all') {
    return res.json(getCachedRooms());
  }

  // Filtriraj samo sobe kojima korisnik ima pristup i koje postoje u konfiguraciji
  const ids = u.rooms.filter(id => hasRoom(id));
  res.json(getCachedRooms(ids.length > 0 ? ids : []));
});

app.get('/api/rooms/:id', (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });
  res.json(getCachedRooms([req.params.id])[0]);
});

// Naredbe se i dalje šalju REST-om prema HA
app.post('/api/rooms/:id/command', async (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });

  const e = getEntityIds(req.params.id);
  const { action, value } = req.body;

  try {
    switch (action) {
      case 'up':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await haCallService('cover', 'open_cover', { entity_id: e.shade });
        break;
      case 'down':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await haCallService('cover', 'close_cover', { entity_id: e.shade });
        break;
      case 'stop':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await haCallService('cover', 'stop_cover', { entity_id: e.shade });
        break;
      case 'set_position':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await haCallService('cover', 'set_cover_position', { entity_id: e.shade, position: value });
        break;
      case 'set_mode':
        if (!e.mode) return res.status(400).json({ error: 'Soba nema mode entitet' });
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
    res.json(getCachedRooms([req.params.id])[0]);
  } catch (err) {
    console.error('Command greška:', err);
    res.status(502).json({ error: 'Greška pri slanju naredbe u Home Assistant' });
  }
});

app.post('/api/rooms/:id/schedule', (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });
  res.json({ id: req.params.id, schedule: updateSchedule(req.params.id, req.body) });
});

app.post('/api/admin/group', async (req, res) => {
  const { action, floor } = req.body;
  const targets = getGroupShadeTargets(floor);

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

  // 1. Otkrij fizičke SmartShade uređaje iz HA registryja
  await refreshRoomConfigFromHa();

  // 2. Učitaj početno stanje iz HA REST-a
  await initialRestLoad();

  // 3. Otvori WebSocket prema HA za live evente
  connectHaWebSocket();
});
