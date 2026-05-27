const socket = io();
let currentRoomId = '101';
let rooms = [];

async function fetchRooms() {
  const res = await fetch('/api/rooms?user=stanar101');
  rooms = await res.json();
  updateRoomSelect();
  const room = rooms.find((r) => r.id === currentRoomId) || rooms[0];
  if (room) updateUI(room);
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
  document.getElementById('sliderValue').textContent = room.position;
  document.getElementById('positionSlider').value = room.position;

  const overlay = document.getElementById('lightOverlay');
  overlay.style.opacity = room.position / 100;

  document.getElementById('tempValue').textContent = room.temperature.toFixed(1);
  document.getElementById('lightValue').textContent = Math.round(room.light);
  document.getElementById('humidityValue').textContent = Math.round(room.humidity);

  const badge = document.getElementById('modeBadge');
  if (room.mode === 'auto') {
    badge.textContent = 'Automatski način rada aktivan';
    badge.className = 'mode-badge mode-auto';
  } else {
    badge.textContent = 'Ručni način rada aktivan';
    badge.className = 'mode-badge mode-manual';
  }

  document.getElementById('btnAuto').classList.toggle('active', room.mode === 'auto');
  document.getElementById('btnManual').classList.toggle('active', room.mode === 'manual');

  document.querySelectorAll('[data-pref]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pref === room.lightPreference);
  });

  document.getElementById('scheduleOpen').value = room.schedule.open;
  document.getElementById('scheduleClose').value = room.schedule.close;
}

async function sendCommand(action, value) {
  await fetch(`/api/rooms/${currentRoomId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value })
  });
}

function showNotification(data) {
  const container = document.getElementById('notifications');
  const div = document.createElement('div');
  div.className = 'notification';
  div.innerHTML = `
    <p><strong>${data.roomName}</strong><br>${data.message}</p>
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

document.getElementById('btnUp').addEventListener('click', () => sendCommand('up'));
document.getElementById('btnDown').addEventListener('click', () => sendCommand('down'));
document.getElementById('btnStop').addEventListener('click', () => sendCommand('stop'));

document.getElementById('positionSlider').addEventListener('input', (e) => {
  document.getElementById('sliderValue').textContent = e.target.value;
});
document.getElementById('positionSlider').addEventListener('change', (e) => {
  sendCommand('set_position', parseInt(e.target.value));
});

document.getElementById('btnAuto').addEventListener('click', () => sendCommand('set_mode', 'auto'));
document.getElementById('btnManual').addEventListener('click', () => sendCommand('set_mode', 'manual'));

document.querySelectorAll('[data-pref]').forEach((btn) => {
  btn.addEventListener('click', () => sendCommand('set_light_preference', btn.dataset.pref));
});

document.getElementById('btnSaveSchedule').addEventListener('click', async () => {
  await fetch(`/api/rooms/${currentRoomId}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      open: document.getElementById('scheduleOpen').value,
      close: document.getElementById('scheduleClose').value
    })
  });
  alert('Raspored spremljen!');
});

socket.on('rooms-update', (updatedRooms) => {
  rooms = updatedRooms.filter((r) => ['101', '102'].includes(r.id));
  const room = rooms.find((r) => r.id === currentRoomId);
  if (room) updateUI(room);
});

socket.on('notification', (data) => {
  if (data.roomId === currentRoomId || data.type === 'offline-alert') {
    showNotification(data);
  }
});

fetchRooms();
