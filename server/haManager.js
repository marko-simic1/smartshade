// Upravljanje s više Home Assistant instanci.
// Svaki stanar ima svoj HA instance (baseUrl + token). Manager za svaku instancu
// drži zasebnu discovery + REST load + WebSocket vezu i rutira naredbe u pravi HA.

const WebSocket = require('ws');
const { discoverPhysicalRooms } = require('./haDiscovery');
const {
  applyEntityState,
  buildVirtualRoomConfigs,
  getConfiguredRoomIdsByHa,
  getEntityIds,
  getRoomHa,
  replaceRoomConfig
} = require('./roomStore');

const RECONNECT_MS = 5000;

// ─── Parsiranje konfiguracije instanci iz env-a ───────────────────────────────
// Podržava: HA1_BASE_URL/HA1_TOKEN/HA1_LABEL/HA1_VIRTUAL, HA2_..., itd.
// Fallback: stari HA_BASE_URL/HA_TOKEN postaje instanca "ha1".

function normBaseUrl(url) {
  return (url || '').replace(/\/$/, '');
}

function wsUrlFor(baseUrl) {
  return baseUrl.replace(/^http/, 'ws') + '/api/websocket';
}

function parseHaInstances(env) {
  const instances = [];

  for (let n = 1; n <= 9; n++) {
    const baseUrl = normBaseUrl(env[`HA${n}_BASE_URL`]);
    if (!baseUrl) continue;
    instances.push({
      id: `ha${n}`,
      baseUrl,
      token: env[`HA${n}_TOKEN`] || '',
      label: env[`HA${n}_LABEL`] || `Zgrada ${n}`,
      includeVirtual: env[`HA${n}_VIRTUAL`] != null
        ? env[`HA${n}_VIRTUAL`] === 'true'
        : instances.length === 0, // po defaultu samo prva instanca nosi simulator
      wsUrl: wsUrlFor(baseUrl)
    });
  }

  // Fallback na stari single-HA format
  if (instances.length === 0) {
    const baseUrl = normBaseUrl(env.HA_BASE_URL || 'http://localhost:8123');
    instances.push({
      id: 'ha1',
      baseUrl,
      token: env.HA_TOKEN || '',
      label: env.HA_LABEL || 'Zgrada A',
      includeVirtual: true,
      wsUrl: wsUrlFor(baseUrl)
    });
  }

  return instances;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

function createHaManager(env, { onRoomsChanged }) {
  const instances = parseHaInstances(env);
  const byId = Object.fromEntries(instances.map(i => [i.id, i]));
  const instanceConfigs = {}; // haId → [roomConfig...]
  const sockets = {};         // haId → WebSocket
  const reconnectTimers = {}; // haId → timer
  const subIds = {};          // haId → subscribe message id

  const notify = () => { try { onRoomsChanged(); } catch (e) { console.error('onRoomsChanged greška:', e.message); } };

  // ── REST helperi (po instanci) ──
  async function haFetch(instance, urlPath, options = {}) {
    if (!instance || !instance.token) return null;
    try {
      const res = await fetch(`${instance.baseUrl}${urlPath}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${instance.token}`,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      if (!res.ok) {
        console.warn(`[${instance.id}] HA REST ${urlPath} => HTTP ${res.status}`);
        return null;
      }
      return res.json();
    } catch (e) {
      console.error(`[${instance.id}] HA REST greška (${urlPath}):`, e.message);
      return null;
    }
  }

  function haCallService(instance, domain, service, data) {
    return haFetch(instance, `/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // ── Sastavi sve sobe iz svih instanci i predaj store-u ──
  function rebuildAllRooms() {
    const all = [];
    instances.forEach(i => { (instanceConfigs[i.id] || []).forEach(cfg => all.push(cfg)); });
    replaceRoomConfig(all);
  }

  function baseConfigsFor(instance) {
    return instance.includeVirtual ? buildVirtualRoomConfigs(instance.id, instance.label) : [];
  }

  // ── Discovery fizičkih soba za jednu instancu ──
  async function refreshInstanceConfig(instance) {
    const virtual = baseConfigsFor(instance);
    try {
      const physical = await discoverPhysicalRooms({ haWsUrl: instance.wsUrl, haToken: instance.token });
      const tagged = physical.map(cfg => ({
        ...cfg,
        haId: instance.id,
        haLabel: instance.label,
        id: `${instance.id}__${cfg.id}`
      }));
      instanceConfigs[instance.id] = [...tagged, ...virtual];
      console.log(`[${instance.id}] discovery: ${physical.length} fizičkih, ${virtual.length} virtualnih (${instance.label})`);
    } catch (err) {
      // Zadrži postojeće fizičke ako discovery padne, ali osiguraj virtualne
      const previousPhysical = (instanceConfigs[instance.id] || []).filter(c => c.isPhysical);
      instanceConfigs[instance.id] = [...previousPhysical, ...virtual];
      console.warn(`[${instance.id}] discovery nije uspio: ${err.message}`);
    }
  }

  // ── Početni REST load za jednu instancu ──
  async function restLoadInstance(instance) {
    if (!instance.token) return;
    const loads = [];
    const entityIds = [];
    for (const roomId of getConfiguredRoomIdsByHa(instance.id)) {
      entityIds.push(...Object.values(getEntityIds(roomId) || {}));
    }

    for (const entityId of entityIds) {
      loads.push(
        haFetch(instance, `/api/states/${entityId}`)
          .then(state => { if (state) applyEntityState(instance.id, entityId, state); })
          .catch(() => {})
      );
    }
    await Promise.all(loads);
  }

  // ── WebSocket veza za jednu instancu ──
  function connectInstanceWs(instance) {
    if (!instance.token) {
      console.warn(`[${instance.id}] token nije postavljen — WebSocket preskočen.`);
      return;
    }

    console.log(`[${instance.id}] spajam HA WebSocket: ${instance.wsUrl}`);
    const ws = new WebSocket(instance.wsUrl);
    sockets[instance.id] = ws;
    subIds[instance.id] = 1;

    ws.on('open', () => { clearTimeout(reconnectTimers[instance.id]); });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: instance.token }));
        return;
      }
      if (msg.type === 'auth_ok') {
        console.log(`[${instance.id}] WebSocket autentificiran (HA ${msg.ha_version})`);
        ws.send(JSON.stringify({ id: subIds[instance.id], type: 'subscribe_events', event_type: 'state_changed' }));
        return;
      }
      if (msg.type === 'auth_invalid') {
        console.error(`[${instance.id}] neispravan token! Provjeri HA token u .env`);
        ws.close();
        return;
      }
      if (msg.type === 'result' && msg.id === subIds[instance.id]) {
        if (msg.success) console.log(`[${instance.id}] pretplaćen na state_changed`);
        else console.error(`[${instance.id}] pretplata nije uspjela`, msg.error);
        return;
      }
      if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
        const { entity_id, new_state } = msg.event.data;
        if (applyEntityState(instance.id, entity_id, new_state)) notify();
      }
    });

    ws.on('close', () => {
      console.warn(`[${instance.id}] WebSocket prekinut. Reconnect za ${RECONNECT_MS / 1000}s...`);
      scheduleReconnect(instance);
    });

    ws.on('error', (err) => { console.error(`[${instance.id}] WebSocket greška:`, err.message); });
  }

  function scheduleReconnect(instance) {
    clearTimeout(reconnectTimers[instance.id]);
    reconnectTimers[instance.id] = setTimeout(async () => {
      console.log(`[${instance.id}] pokušavam reconnect...`);
      await refreshInstanceConfig(instance);
      rebuildAllRooms();
      await restLoadInstance(instance);
      notify();
      connectInstanceWs(instance);
    }, RECONNECT_MS);
  }

  // ── Javni API ──

  async function start() {
    // 1. Odmah prikaži virtualne sobe (app radi i bez HA-a)
    instances.forEach(i => { instanceConfigs[i.id] = baseConfigsFor(i); });
    rebuildAllRooms();

    console.log(`HA instance: ${instances.map(i => `${i.id}(${i.label}${i.token ? '' : ', bez tokena'})`).join(', ')}`);

    // 2. Po instanci: discovery → REST load → WebSocket
    for (const instance of instances) {
      if (!instance.token) continue;
      await refreshInstanceConfig(instance);
      rebuildAllRooms();
      await restLoadInstance(instance);
      connectInstanceWs(instance);
    }
    notify();
  }

  // Naredba za jednu sobu — ide u HA instance kojem soba pripada
  function callServiceForRoom(roomId, domain, service, data) {
    const instance = byId[getRoomHa(roomId)];
    if (!instance) return Promise.reject(new Error('Soba nema povezan HA instance'));
    return haCallService(instance, domain, service, data);
  }

  // Grupno — targets = [{ haId, entityId }], svaki ide u svoj HA
  function callServiceForTargets(targets, domain, service) {
    return Promise.all(targets.map(t => {
      const instance = byId[t.haId];
      if (!instance) return Promise.resolve(null);
      return haCallService(instance, domain, service, { entity_id: t.entityId });
    }));
  }

  function getInstances() {
    return instances.map(i => ({ id: i.id, label: i.label, baseUrl: i.baseUrl, hasToken: Boolean(i.token) }));
  }

  return { start, callServiceForRoom, callServiceForTargets, getInstances };
}

module.exports = { createHaManager, parseHaInstances };
