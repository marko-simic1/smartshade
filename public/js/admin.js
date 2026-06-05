const socket = io();

async function fetchDevices() {
  const res = await fetch('/api/rooms');
  const rooms = await res.json();
  renderTable(rooms);
}

async function fetchEnergy() {
  const res = await fetch('/api/admin/energy');
  const data = await res.json();
  document.getElementById('totalSavings').textContent = data.totalSavings + ' kWh (procjena)';

  const chart = document.getElementById('energyChart');
  const maxSavings = Math.max(...data.rooms.map((r) => r.savings), 1);
  chart.innerHTML = data.rooms.map((r) => `
    <div class="chart-bar">
      <div class="chart-bar-label">${r.name}</div>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width: ${(r.savings / maxSavings) * 100}%"></div>
      </div>
      <div class="chart-bar-value">${r.savings}%</div>
    </div>
  `).join('');
}

async function fetchUsers() {
  const res = await fetch('/api/users');
  const users = await res.json();
  const tbody = document.getElementById('usersTable');
  tbody.innerHTML = Object.entries(users).map(([name, u]) => `
    <tr>
      <td>${name}</td>
      <td>${u.role === 'admin' ? 'Administrator' : 'Stanar'}</td>
      <td>${u.access}</td>
    </tr>
  `).join('');
}

function renderTable(rooms) {
  const tbody = document.getElementById('devicesTable');
  tbody.innerHTML = rooms.map((r) => `
    <tr>
      <td>
        <span class="status-dot ${r.online ? 'status-online' : 'status-offline'}"></span>
        ${r.online ? 'Online' : 'Offline'}
      </td>
      <td>${r.name}</td>
      <td>${r.haLabel || r.haId || '—'}</td>
      <td>Kat ${r.floor}</td>
      <td>${r.temperature.toFixed(1)} °C</td>
      <td>${Math.round(r.light)} lux</td>
      <td>${r.position}%</td>
      <td>${r.mode === 'auto' ? 'Auto' : 'Ručno'}</td>
      <td>${r.isPhysical ? 'Fizički ESP32' : 'Virtualni'}</td>
    </tr>
  `).join('');
}

function showAlert(data) {
  const container = document.getElementById('notifications');
  const div = document.createElement('div');
  div.className = 'notification';
  div.style.borderColor = 'var(--danger)';
  div.innerHTML = `<p><strong>Upozorenje!</strong><br>${data.message}</p>`;
  container.appendChild(div);
  setTimeout(() => div.remove(), 10000);
}

async function groupAction(action, floor) {
  await fetch('/api/admin/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, floor })
  });
}

document.getElementById('btnCloseAll').addEventListener('click', () => groupAction('close_all'));
document.getElementById('btnOpenAll').addEventListener('click', () => groupAction('open_all'));
document.getElementById('btnCloseFloor1').addEventListener('click', () => groupAction('close_all', 1));
document.getElementById('btnOpenFloor1').addEventListener('click', () => groupAction('open_all', 1));
document.getElementById('btnCloseFloor2').addEventListener('click', () => groupAction('close_all', 2));
document.getElementById('btnOpenFloor2').addEventListener('click', () => groupAction('open_all', 2));

socket.on('rooms-update', (rooms) => {
  renderTable(rooms);
  fetchEnergy();
});

socket.on('notification', (data) => {
  if (data.type === 'offline-alert') showAlert(data);
});

fetchDevices();
fetchEnergy();
fetchUsers();
