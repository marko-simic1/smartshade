const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const mqtt = require('mqtt');

const PORT = process.env.PORT || 3000;
const MQTT_URL = process.env.MQTT_URL || 'mqtt://test.mosquitto.org';
const USE_MQTT = process.env.USE_MQTT === 'true';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Hijerarhija: Hotel_Zadar -> Kat -> Soba
const rooms = {};
const users = {
  admin: { role: 'admin', rooms: 'all' },
  stanar101: { role: 'resident', rooms: ['101'] },
  stanar102: { role: 'resident', rooms: ['102'] }
};

function createRoom(id, floor, name, isPhysical = false) {
  return {
    id,
    name,
    floor,
    building: 'Hotel_Zadar',
    isPhysical,
    online: true,
    lastSeen: Date.now(),
    temperature: 22 + Math.random() * 3,
    humidity: 45 + Math.random() * 15,
    light: 300 + Math.random() * 400,
    position: 50,
    mode: 'auto',
    lightPreference: 'medium',
    schedule: { open: '07:00', close: '22:00' },
    windSpeed: 5 + Math.random() * 10,
    moving: false
  };
}

// Soba 101 = fizički ESP32, ostale simulirane
rooms['101'] = createRoom('101', 1, 'Soba 101', true);
for (let i = 102; i <= 111; i++) {
  rooms[String(i)] = createRoom(String(i), i <= 105 ? 1 : 2, `Soba ${i}`);
}

const LIGHT_THRESHOLDS = {
  low: { min: 0, max: 250, target: 150 },
  medium: { min: 200, max: 500, target: 350 },
  high: { min: 400, max: 900, target: 650 }
};

function mqttTopic(roomId, type) {
  const r = rooms[roomId];
  return `smartshade/${r.building}/Kat_${r.floor}/Soba_${roomId}/${type}`;
}

function broadcastUpdate() {
  io.emit('rooms-update', getRoomsList());
}

function getRoomsList() {
  return Object.values(rooms).map((r) => ({ ...r }));
}

function publishCommand(roomId, payload) {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(mqttTopic(roomId, 'command'), JSON.stringify(payload));
  }
}

function applyPosition(roomId, position, reason) {
  const room = rooms[roomId];
  if (!room || room.mode !== 'auto' && reason === 'automation') return;

  position = Math.max(0, Math.min(100, Math.round(position)));
  room.position = position;
  room.moving = false;
  room.lastSeen = Date.now();
  room.online = true;

  if (reason) {
    console.log(`${room.name}: Roletne na ${position}% - ${reason}`);
  }

  publishCommand(roomId, { action: 'set_position', position });
  broadcastUpdate();
}

function runAutomation(room) {
  if (room.mode !== 'auto') return;

  const hour = new Date().getHours();
  const pref = LIGHT_THRESHOLDS[room.lightPreference];
  const isNight = hour >= 22 || hour < 6;
  const isHot = room.temperature > 26;
  const isCold = room.temperature < 20;
  const isBright = room.light > pref.max;
  const isSunnyOutside = room.light > 500;
  const isDarkOutside = room.light < 100;
  const isWindy = room.windSpeed > 40;

  if (isWindy) {
    applyPosition(room.id, 100, `Podignute zbog jakog vjetra (${room.windSpeed.toFixed(0)} km/h)`);
    return;
  }

  if (isNight) {
    applyPosition(room.id, 0, 'Noć - automatsko spuštanje');
    return;
  }

  if (isHot && isBright) {
    applyPosition(room.id, 0, 'Ljeto - spuštene (toplo + sunce)');
    return;
  }

  if (isCold && isSunnyOutside) {
    applyPosition(room.id, 80, 'Zima - dignute (sunce grije prostor)');
    return;
  }

  // Drži optimalni intenzitet svjetlosti
  if (room.light < pref.min) {
    applyPosition(room.id, Math.min(100, room.position + 10), 'Povećavanje svjetlosti');
  } else if (room.light > pref.max) {
    applyPosition(room.id, Math.max(0, room.position - 10), 'Smanjivanje svjetlosti');
  }
}

function checkSmartReminder(room) {
  const isDarkOutside = room.light < 80;
  if (isDarkOutside && room.position > 30) {
    io.emit('notification', {
      roomId: room.id,
      roomName: room.name,
      message: 'Vani je mrak. Želite li spustiti roletne radi privatnosti?',
      type: 'smart-reminder'
    });
  }
}

function checkOfflineSensors() {
  const now = Date.now();
  Object.values(rooms).forEach((room) => {
    const wasOnline = room.online;
    room.online = now - room.lastSeen < 60000;
    if (wasOnline && !room.online) {
      io.emit('notification', {
        roomId: room.id,
        roomName: room.name,
        message: `Senzor u ${room.name} prestao slati podatke!`,
        type: 'offline-alert'
      });
    }
  });
}

function simulateSensorData() {
  Object.values(rooms).forEach((room) => {
    if (room.isPhysical) return;

    room.temperature += (Math.random() - 0.5) * 0.3;
    room.humidity += (Math.random() - 0.5) * 1;
    room.light += (Math.random() - 0.5) * 30;
    room.windSpeed += (Math.random() - 0.5) * 2;
    room.windSpeed = Math.max(0, Math.min(80, room.windSpeed));
    room.lastSeen = Date.now();
    room.online = true;

    runAutomation(room);
    checkSmartReminder(room);
  });
  broadcastUpdate();
}

// MQTT
let mqttClient = null;

if (USE_MQTT) {
  mqttClient = mqtt.connect(MQTT_URL);

  mqttClient.on('connect', () => {
    console.log('MQTT spojen:', MQTT_URL);
    Object.keys(rooms).forEach((id) => {
      mqttClient.subscribe(mqttTopic(id, 'telemetry'));
    });
  });

  mqttClient.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      const match = topic.match(/Soba_(\d+)\/telemetry/);
      if (!match) return;

      const room = rooms[match[1]];
      if (!room) return;

      if (data.temperature !== undefined) room.temperature = data.temperature;
      if (data.humidity !== undefined) room.humidity = data.humidity;
      if (data.light !== undefined) room.light = data.light;
      if (data.position !== undefined) room.position = data.position;
      if (data.mode !== undefined) room.mode = data.mode;
      room.lastSeen = Date.now();
      room.online = true;

      runAutomation(room);
      broadcastUpdate();
    } catch (e) {
      console.error('MQTT parse error:', e.message);
    }
  });
}

// API
app.get('/api/rooms', (req, res) => {
  const user = req.query.user || 'admin';
  const u = users[user];
  if (!u) return res.status(403).json({ error: 'Nepoznat korisnik' });

  let list = getRoomsList();
  if (u.rooms !== 'all') {
    list = list.filter((r) => u.rooms.includes(r.id));
  }
  res.json(list);
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Soba nije pronađena' });
  res.json(room);
});

app.post('/api/rooms/:id/command', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Soba nije pronađena' });

  const { action, value } = req.body;
  room.mode = 'manual';
  room.moving = true;
  room.lastSeen = Date.now();

  switch (action) {
    case 'up':
      room.position = Math.min(100, room.position + 10);
      break;
    case 'down':
      room.position = Math.max(0, room.position - 10);
      break;
    case 'stop':
      room.moving = false;
      break;
    case 'set_position':
      room.position = Math.max(0, Math.min(100, value));
      room.moving = false;
      break;
    case 'set_mode':
      room.mode = value;
      if (value === 'auto') runAutomation(room);
      break;
    case 'set_light_preference':
      room.lightPreference = value;
      if (room.mode === 'auto') runAutomation(room);
      break;
    default:
      return res.status(400).json({ error: 'Nepoznata naredba' });
  }

  publishCommand(room.id, { action, value: room.position });
  setTimeout(() => {
    room.moving = false;
    broadcastUpdate();
  }, 500);

  broadcastUpdate();
  res.json(room);
});

app.post('/api/rooms/:id/schedule', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Soba nije pronađena' });
  room.schedule = { ...room.schedule, ...req.body };
  res.json(room);
});

app.post('/api/admin/group', (req, res) => {
  const { action, floor } = req.body;
  Object.values(rooms).forEach((room) => {
    if (floor && room.floor !== floor) return;
    room.mode = 'manual';
    if (action === 'close_all') room.position = 0;
    if (action === 'open_all') room.position = 100;
    publishCommand(room.id, { action: 'set_position', value: room.position });
  });
  broadcastUpdate();
  res.json({ success: true, affected: getRoomsList().length });
});

app.get('/api/admin/energy', (req, res) => {
  const data = Object.values(rooms).map((r) => {
    const closedPercent = 100 - r.position;
    const savings = Math.round(closedPercent * 0.15 + (r.mode === 'auto' ? 10 : 0));
    return { id: r.id, name: r.name, savings, position: r.position };
  });
  const total = data.reduce((sum, d) => sum + d.savings, 0);
  res.json({ rooms: data, totalSavings: total });
});

app.get('/api/users', (req, res) => {
  res.json(users);
});

io.on('connection', (socket) => {
  socket.emit('rooms-update', getRoomsList());
});

// Raspored - provjera svake minute
setInterval(() => {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  Object.values(rooms).forEach((room) => {
    if (room.schedule.open === timeStr) applyPosition(room.id, 100, 'Raspored - otvaranje');
    if (room.schedule.close === timeStr) applyPosition(room.id, 0, 'Raspored - zatvaranje');
  });
}, 60000);

setInterval(simulateSensorData, 5000);
setInterval(checkOfflineSensors, 10000);

server.listen(PORT, () => {
  console.log(`SmartShade web app: http://localhost:${PORT}`);
  console.log(`MQTT: ${USE_MQTT ? MQTT_URL : 'isključen (simulacija)'}`);
});
