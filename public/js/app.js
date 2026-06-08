const socket = io();
let currentRoomId = '101';
let rooms = [];
let activeLightPreference = 'medium';
let thresholdDragging = false;

async function fetchRooms() {
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rooms = await res.json();
    updateRoomSelect();
    const room = rooms.find((r) => r.id === currentRoomId) || rooms[0];
    if (room) {
      currentRoomId = room.id;
      updateRoomSelect();
      updateUI(room);
    }
  } catch (e) {
    console.error('Greška pri dohvatu soba:', e);
  }
}

function updateRoomSelect() {
  const select = document.getElementById('roomSelect');
  select.innerHTML = rooms.map((r) =>
    `<option value="${r.id}" ${r.id === currentRoomId ? 'selected' : ''}>${r.name} (Kat ${r.floor})</option>`
  ).join('');
}

function updateUI(room) {
  const closedPercent = 100 - room.position;

  document.getElementById('blind').style.height = closedPercent + '%';
  document.getElementById('positionText').textContent = room.position;
  document.getElementById('positionSlider').value = 100 - room.position;
  document.getElementById('sliderDragLabel').textContent = room.position + '%';

  const overlay = document.getElementById('lightOverlay');
  overlay.style.opacity = room.position / 100;

  document.getElementById('tempValue').textContent =
    room.temperature ? room.temperature.toFixed(1) : '--';
  document.getElementById('lightValue').textContent =
    room.light ? Math.round(room.light) : '--';
  document.getElementById('humidityValue').textContent =
    room.humidity ? Math.round(room.humidity) : '--';
  document.getElementById('windValue').textContent =
    (room.windSpeed || room.windSpeed === 0) ? Math.round(room.windSpeed) : '--';
  document.getElementById('rainValue').textContent = room.rain ? 'Da' : 'Ne';

  document.getElementById('modeSwitch').checked = room.mode === 'auto';
  document.getElementById('labelAuto').classList.toggle('active', room.mode === 'auto');
  document.getElementById('labelManual').classList.toggle('active', room.mode === 'manual');
  setControlsDimmed(room.mode === 'auto');

  // Intenzitet svjetlosti je globalna HA postavka (po zgradi) - prikaži stanje iz HA
  const preset = (room.lightPreset || 'Medium').toLowerCase();
  activeLightPreference = preset;
  document.querySelectorAll('[data-pref]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pref === preset);
  });
  const customWrap = document.getElementById('customThresholdWrap');
  const threshold = room.lightThreshold || 700;
  if (customWrap) customWrap.style.display = preset === 'custom' ? 'block' : 'none';
  if (!thresholdDragging) {
    document.getElementById('thresholdSlider').value = threshold;
    document.getElementById('thresholdValue').textContent = threshold;
  }

  if (room.schedule) {
    document.getElementById('scheduleOpen').value = room.schedule.open || '07:00';
    document.getElementById('scheduleClose').value = room.schedule.close || '22:00';
  }

  // Show offline warning if room is not reachable in HA
  const offlineBanner = document.getElementById('offlineBanner');
  if (offlineBanner) {
    offlineBanner.style.display = room.online ? 'none' : 'block';
  }
}

function setControlsDimmed(dimmed) {
  document.querySelector('.blind-control-row').classList.toggle('controls-dimmed', dimmed);
}

function switchToManualIfNeeded() {
  const room = rooms.find(r => r.id === currentRoomId);
  if (!room || room.mode !== 'auto') return;
  room.mode = 'manual';
  document.getElementById('modeSwitch').checked = false;
  document.getElementById('labelAuto').classList.remove('active');
  document.getElementById('labelManual').classList.add('active');
  setControlsDimmed(false);
  sendCommand('set_mode', 'manual');
}

async function sendCommand(action, value) {
  try {
    const res = await fetch(`/api/rooms/${currentRoomId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, value })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('Naredba odbijena:', err.error || res.status);
    }
  } catch (e) {
    console.error('Greška pri slanju naredbe:', e);
  }
}

function showNotification(data) {
  const container = document.getElementById('notifications');
  const div = document.createElement('div');
  div.className = 'notification';
  div.innerHTML = `
    <p><strong>${data.roomName || 'Obavijest'}</strong><br>${data.message}</p>
    <div class="notification-actions">
      <button style="background: var(--accent); color: #fff;" data-action="yes">Da, spusti</button>
      <button style="background: var(--surface2); color: var(--text);" data-action="no">Ne sada</button>
    </div>
  `;

  div.querySelector('[data-action="yes"]').addEventListener('click', () => {
    sendCommand('set_position', 0);
    div.remove();
  });
  div.querySelector('[data-action="no"]').addEventListener('click', () => div.remove());

  container.appendChild(div);
  setTimeout(() => div.remove(), 15000);
}

document.getElementById('roomSelect').addEventListener('change', (e) => {
  currentRoomId = e.target.value;
  const room = rooms.find((r) => r.id === currentRoomId);
  if (room) updateUI(room);
});

document.getElementById('btnUp').addEventListener('click', () => {
  switchToManualIfNeeded();
  sendCommand('up');
});
document.getElementById('btnDown').addEventListener('click', () => {
  switchToManualIfNeeded();
  sendCommand('down');
});
document.getElementById('btnStop').addEventListener('click', () => {
  switchToManualIfNeeded();
  sendCommand('stop');
});

document.getElementById('positionSlider').addEventListener('input', (e) => {
  document.getElementById('sliderDragLabel').textContent = (100 - e.target.value) + '%';
  switchToManualIfNeeded();
});
document.getElementById('positionSlider').addEventListener('change', (e) => {
  sendCommand('set_position', 100 - parseInt(e.target.value));
});

document.getElementById('modeSwitch').addEventListener('change', (e) => {
  const isAuto = e.target.checked;
  const room = rooms.find(r => r.id === currentRoomId);
  if (room) room.mode = isAuto ? 'auto' : 'manual';
  document.getElementById('labelAuto').classList.toggle('active', isAuto);
  document.getElementById('labelManual').classList.toggle('active', !isAuto);
  setControlsDimmed(isAuto);
  sendCommand('set_mode', isAuto ? 'auto' : 'manual');
});

document.querySelectorAll('[data-pref]').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeLightPreference = btn.dataset.pref;
    document.querySelectorAll('[data-pref]').forEach((b) =>
      b.classList.toggle('active', b.dataset.pref === activeLightPreference)
    );
    const isCustom = btn.dataset.pref === 'custom';
    document.getElementById('customThresholdWrap').style.display = isCustom ? 'block' : 'none';
    sendCommand('set_light_preference', btn.dataset.pref);
  });
});

// Custom prag svjetla (200-1200 lx)
document.getElementById('thresholdSlider').addEventListener('input', (e) => {
  thresholdDragging = true;
  document.getElementById('thresholdValue').textContent = e.target.value;
});
document.getElementById('thresholdSlider').addEventListener('change', (e) => {
  thresholdDragging = false;
  sendCommand('set_light_threshold', parseInt(e.target.value, 10));
});

document.getElementById('btnSaveSchedule').addEventListener('click', async () => {
  try {
    const res = await fetch(`/api/rooms/${currentRoomId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        open: document.getElementById('scheduleOpen').value,
        close: document.getElementById('scheduleClose').value
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Greška pri spremanju rasporeda.');
    }
    alert('Raspored spremljen!');
  } catch (e) {
    alert(e.message || 'Greška pri spremanju rasporeda.');
  }
});

socket.on('rooms-update', (updatedRooms) => {
  rooms = updatedRooms;
  const room = rooms.find((r) => r.id === currentRoomId);
  if (room) updateUI(room);
});

socket.on('notification', (data) => {
  if (data.roomId === currentRoomId || data.type === 'offline-alert') {
    showNotification(data);
  }
});

fetchRooms();
