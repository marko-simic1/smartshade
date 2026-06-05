// Zajednička auth logika za zaštićene stranice:
// dohvati trenutnog korisnika, popuni header, sakrij admin link stanaru, omogući odjavu.
(async function () {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) {
      window.location = '/login.html';
      return;
    }
    const me = await res.json();
    window.__me = me;

    const box = document.getElementById('userBox');
    if (box) {
      const roleLabel = me.role === 'admin' ? 'Administrator' : 'Stanar';
      box.innerHTML =
        `<span class="nav-user">${me.username} · ${roleLabel}</span>` +
        `<a href="#" id="logoutLink">Odjava</a>`;
      document.getElementById('logoutLink').addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/api/logout', { method: 'POST' });
        window.location = '/login.html';
      });
    }

    // Stanar ne vidi link na admin sučelje
    const navAdmin = document.getElementById('navAdmin');
    if (navAdmin && me.role !== 'admin') navAdmin.style.display = 'none';
  } catch (e) {
    window.location = '/login.html';
  }
})();
