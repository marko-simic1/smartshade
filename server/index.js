require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createHaManager } = require('./haManager');
const {
  getCachedRooms,
  getEntityIds,
  getGroupShadeTargets,
  getScheduleEntityIds,
  hasRoom,
  updateSchedule
} = require('./roomStore');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ─── Zaštita stranica ─────────────────────────────────────────────────────────
// Login stranica + statički resursi (css/js) su javni; index/admin traže prijavu.

function pageGuard(role) {
  return (req, res, next) => {
    const u = userFromCookie(req.headers.cookie);
    if (!u) return res.redirect('/login.html');
    if (role === 'admin' && u.role !== 'admin') return res.redirect('/');
    next();
  };
}

app.get(['/', '/index.html'], pageGuard(), (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/admin.html', pageGuard('admin'), (req, res) =>
  res.sendFile(path.join(__dirname, '../public/admin.html')));

// index:false da static ne servira index.html mimo guarda iznad
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ─── Prijava / odjava ─────────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = users[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'Pogrešno korisničko ime ili lozinka' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = username;
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
  res.json({ username, role: u.role });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) delete sessions[token];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.name, role: req.user.role, rooms: req.user.rooms });
});

// ─── Korisnici ────────────────────────────────────────────────────────────────

// Stanar je vezan na svoj HA instance (ha). Admin vidi sve instance (cijela zgrada).
const users = {
  admin:    { password: 'admin123', role: 'admin' },
  stanar1:  { password: 'soba1',    role: 'resident', ha: 'ha1' },
  stanar2:  { password: 'soba2',    role: 'resident', ha: 'ha2' }
};

// ─── Sesije (in-memory, cookie-based) ─────────────────────────────────────────

const crypto = require('crypto');
const sessions = {}; // token → username

function parseCookies(cookieHeader) {
  const out = {};
  (cookieHeader || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Korisnik iz cookieja (radi i za HTTP requestove i za Socket.IO handshake)
function userFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).sid;
  const username = token && sessions[token];
  if (!username || !users[username]) return null;
  return { name: username, ...users[username] };
}

function requireAuth(req, res, next) {
  const u = userFromCookie(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Niste prijavljeni' });
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Samo administrator' });
  next();
}

// Sobe koje korisnik smije vidjeti: admin sve, stanar samo svoj HA instance
function roomsForUser(user) {
  if (!user) return [];
  if (user.role === 'admin') return getCachedRooms();
  return getCachedRooms().filter(r => r.haId === user.ha);
}

function canAccessRoom(user, roomId) {
  if (!user || !hasRoom(roomId)) return false;
  if (user.role === 'admin') return true;
  const room = getCachedRooms([roomId])[0];
  return room && room.haId === user.ha;
}

function toHaTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] == null ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  return `${match[1]}:${match[2]}:${String(seconds).padStart(2, '0')}`;
}

// Pošalji svakom spojenom browseru samo sobe na koje ima pravo
function broadcastRooms() {
  for (const [, socket] of io.of('/').sockets) {
    socket.emit('rooms-update', roomsForUser(userFromCookie(socket.handshake.headers.cookie)));
  }
}

// ─── HA instance manager ──────────────────────────────────────────────────────
// Svaki stanar ima svoj HA instance. Manager za svaku instancu drži zasebnu
// discovery + REST load + WebSocket vezu i rutira naredbe u pravi HA.
// onRoomsChanged se okida kad bilo koja instanca javi promjenu stanja.

const haManager = createHaManager(process.env, { onRoomsChanged: broadcastRooms });

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/rooms', requireAuth, (req, res) => {
  res.json(roomsForUser(req.user));
});

app.get('/api/rooms/:id', requireAuth, (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });
  if (!canAccessRoom(req.user, req.params.id)) return res.status(403).json({ error: 'Nemate pristup ovoj sobi' });
  res.json(getCachedRooms([req.params.id])[0]);
});

// Naredbe se i dalje šalju REST-om prema HA
app.post('/api/rooms/:id/command', requireAuth, async (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });
  if (!canAccessRoom(req.user, req.params.id)) return res.status(403).json({ error: 'Nemate pristup ovoj sobi' });

  const roomId = req.params.id;
  const e = getEntityIds(roomId);
  const { action, value } = req.body;
  const call = (domain, service, data) => haManager.callServiceForRoom(roomId, domain, service, data);

  try {
    switch (action) {
      case 'up':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await call('cover', 'open_cover', { entity_id: e.shade });
        break;
      case 'down':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await call('cover', 'close_cover', { entity_id: e.shade });
        break;
      case 'stop':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await call('cover', 'stop_cover', { entity_id: e.shade });
        break;
      case 'set_position':
        if (!e.shade) return res.status(400).json({ error: 'Soba nema cover entitet' });
        await call('cover', 'set_cover_position', { entity_id: e.shade, position: value });
        break;
      case 'set_mode':
        if (!e.mode) return res.status(400).json({ error: 'Soba nema mode entitet' });
        await call('select', 'select_option', { entity_id: e.mode, option: value });
        break;
      case 'set_light_preference': {
        if (!e.lightPreset) return res.status(400).json({ error: 'Soba nema light preset helper' });
        const presetMap = { low: 'Low', medium: 'Medium', high: 'High', custom: 'Custom' };
        await call('input_select', 'select_option', {
          entity_id: e.lightPreset,
          option: presetMap[value] || value
        });
        break;
      }
      case 'set_light_threshold': {
        if (!e.lightThreshold) return res.status(400).json({ error: 'Soba nema custom light threshold helper' });
        const v = Number(value);
        if (!Number.isFinite(v)) return res.status(400).json({ error: 'Neispravan prag svjetla' });
        await call('input_number', 'set_value', {
          entity_id: e.lightThreshold,
          value: v
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

app.post('/api/rooms/:id/schedule', requireAuth, async (req, res) => {
  if (!hasRoom(req.params.id)) return res.status(404).json({ error: 'Soba nije pronađena' });
  if (!canAccessRoom(req.user, req.params.id)) return res.status(403).json({ error: 'Nemate pristup ovoj sobi' });

  const open = toHaTime(req.body?.open);
  const close = toHaTime(req.body?.close);
  if (!open || !close) return res.status(400).json({ error: 'Neispravan format rasporeda' });

  const roomId = req.params.id;
  const schedule = updateSchedule(roomId, {
    open: open.slice(0, 5),
    close: close.slice(0, 5)
  });
  const scheduleEntities = getScheduleEntityIds(roomId);

  if (!scheduleEntities) {
    const e = getEntityIds(roomId);
    const shadeObjectId = String(e?.shade || '').split('.')[1]?.replace(/_shade$/, '');
    return res.status(400).json({
      error: shadeObjectId
        ? `Soba nema input_datetime entitete za raspored. Dodijeli morning/open i night/closing input_datetime helpere u istu HA sobu ili ih nazovi input_datetime.${shadeObjectId}_morning_open_time i input_datetime.${shadeObjectId}_night_closing_time`
        : 'Soba nema input_datetime entitete za raspored',
      schedule
    });
  }

  try {
    const results = await Promise.all([
      haManager.callServiceForRoom(roomId, 'input_datetime', 'set_datetime', {
        entity_id: scheduleEntities.open,
        time: open
      }),
      haManager.callServiceForRoom(roomId, 'input_datetime', 'set_datetime', {
        entity_id: scheduleEntities.close,
        time: close
      })
    ]);
    if (results.some(result => !result)) {
      return res.status(502).json({ error: 'Home Assistant nije prihvatio raspored', schedule });
    }

    res.json({ id: roomId, schedule, scheduleEntities, haSynced: true });
  } catch (err) {
    console.error('Schedule sync greška:', err);
    res.status(502).json({ error: 'Greška pri slanju rasporeda u Home Assistant', schedule });
  }
});

app.post('/api/admin/group', requireAuth, requireAdmin, async (req, res) => {
  const { action, floor } = req.body;
  const targets = getGroupShadeTargets(floor); // [{ haId, entityId }] — svaki ide u svoj HA

  const haAction = action === 'close_all' ? 'close_cover' : 'open_cover';
  try {
    await haManager.callServiceForTargets(targets, 'cover', haAction);
    res.json({ success: true, affected: targets.length });
  } catch (e) {
    res.status(502).json({ error: 'Greška pri grupnom upravljanju' });
  }
});

app.get('/api/admin/energy', requireAuth, requireAdmin, (req, res) => {
  const data = getCachedRooms().map(r => {
    const closedPercent = 100 - r.position;
    const savings = Math.round(closedPercent * 0.15 + (r.mode === 'auto' ? 10 : 0));
    return { id: r.id, name: r.name, savings, position: r.position };
  });
  const total = data.reduce((sum, d) => sum + d.savings, 0);
  res.json({ rooms: data, totalSavings: total });
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const instances = Object.fromEntries(haManager.getInstances().map(i => [i.id, i.label]));
  // Ne otkrivaj lozinke; prikaži kojem HA instanceu (zgradi) korisnik pripada
  const safe = Object.fromEntries(
    Object.entries(users).map(([name, u]) => [name, {
      role: u.role,
      access: u.role === 'admin' ? 'Sve zgrade' : (instances[u.ha] || u.ha || '—')
    }])
  );
  res.json(safe);
});

app.get('/api/instances', requireAuth, requireAdmin, (req, res) => {
  res.json(haManager.getInstances());
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Novi browser klijent dobiva odmah samo sobe na koje ima pravo
  socket.emit('rooms-update', roomsForUser(userFromCookie(socket.handshake.headers.cookie)));
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`SmartShade web app: http://localhost:${PORT}`);

  // Manager: za svaku HA instancu discovery → REST load → WebSocket.
  // Bez tokena samo prikazuje virtualne sobe (app i dalje radi za demo logina).
  await haManager.start();
});
