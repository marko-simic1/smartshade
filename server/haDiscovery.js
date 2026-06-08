const WebSocket = require('ws');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'room';
}

function deviceDisplayName(device) {
  return device.name_by_user || device.name || device.model || device.id;
}

function registryText(value) {
  return JSON.stringify(value || {}).toLowerCase();
}

function isVirtualSmartShadeDevice(device) {
  const text = registryText(device);
  return text.includes('virtual room simulator') || text.includes('smartshade_room_');
}

function looksLikeSmartShadeDevice(device, deviceEntities) {
  const text = registryText(device);
  return text.includes('smartshade') ||
    deviceEntities.some(entity => registryText(entity).includes('smartshade'));
}

function fieldForEntity(entity) {
  const entityId = entity.entity_id || '';
  const [domain, objectId = ''] = entityId.split('.');
  const text = `${objectId} ${entity.name || ''} ${entity.original_name || ''}`.toLowerCase();

  if (domain === 'cover') return 'shade';
  if (domain === 'sensor' && text.includes('temperature')) return 'temperature';
  if (domain === 'sensor' && (text.includes('light') || text.includes('illuminance'))) return 'light';
  if (domain === 'sensor' && text.includes('humidity')) return 'humidity';
  if (domain === 'sensor' && text.includes('wind')) return 'wind';
  if (domain === 'binary_sensor' && (text.includes('rain') || text.includes('moisture'))) return 'rain';
  if (domain === 'select' && text.includes('mode')) return 'mode';
  return null;
}

function objectIdFromEntityId(entityId) {
  return String(entityId || '').split('.')[1] || '';
}

function helperExists(helperIds, entityId) {
  return helperIds.has(entityId) ? entityId : null;
}

function entityAreaId(entity, devicesById) {
  return entity.area_id || devicesById[entity.device_id]?.area_id || null;
}

function helperText(entity) {
  const entityId = entity.entity_id || '';
  const objectId = objectIdFromEntityId(entityId);
  return `${objectId} ${entity.name || ''} ${entity.name_by_user || ''} ${entity.original_name || ''}`.toLowerCase();
}

function helperRole(entity) {
  const text = helperText(entity);
  if (
    (text.includes('morning') && text.includes('open')) ||
    text.includes('open_time') ||
    text.includes('jutarnj') ||
    text.includes('otvaranj')
  ) return 'open';

  if (
    (text.includes('night') && (text.includes('closing') || text.includes('close'))) ||
    text.includes('closing_time') ||
    text.includes('close_time') ||
    text.includes('noc') ||
    text.includes('noć') ||
    text.includes('zatvaranj')
  ) return 'close';

  return null;
}

function scheduleHelpersForArea(areaId, helperEntities) {
  if (!areaId) return {};

  const helpers = helperEntities
    .filter(entity => entity.areaId === areaId)
    .sort((a, b) => a.entityId.localeCompare(b.entityId));

  const scheduleOpen = helpers.find(entity => entity.role === 'open')?.entityId;
  const scheduleClose = helpers.find(entity => entity.role === 'close')?.entityId;

  if (!scheduleOpen || !scheduleClose) return {};
  return { scheduleOpen, scheduleClose };
}

function scheduleHelpersForRoom(entitiesForRoom, helperIds, areaId, helperEntities) {
  const shadeObjectId = objectIdFromEntityId(entitiesForRoom.shade).replace(/_shade$/, '');
  const conventional = {
    scheduleOpen: helperExists(helperIds, `input_datetime.${shadeObjectId}_morning_open_time`) ||
      helperExists(helperIds, `input_datetime.${shadeObjectId}_open_time`),
    scheduleClose: helperExists(helperIds, `input_datetime.${shadeObjectId}_night_closing_time`) ||
      helperExists(helperIds, `input_datetime.${shadeObjectId}_close_time`)
  };

  if (conventional.scheduleOpen && conventional.scheduleClose) return conventional;

  return scheduleHelpersForArea(areaId, helperEntities);
}

function buildPhysicalRoomConfigs(areas, devices, entities) {
  const areasById = Object.fromEntries((areas || []).map(area => [area.area_id, area]));
  const devicesById = Object.fromEntries((devices || []).map(device => [device.id, device]));
  const helperIds = new Set(
    (entities || [])
      .map(entity => entity.entity_id)
      .filter(entityId => String(entityId || '').startsWith('input_datetime.'))
  );
  const helperEntities = (entities || [])
    .filter(entity => String(entity.entity_id || '').startsWith('input_datetime.'))
    .map(entity => ({
      entityId: entity.entity_id,
      areaId: entityAreaId(entity, devicesById),
      role: helperRole(entity)
    }))
    .filter(entity => entity.role);
  const entitiesByDevice = {};

  (entities || []).forEach(entity => {
    if (!entity.device_id) return;
    entitiesByDevice[entity.device_id] ||= [];
    entitiesByDevice[entity.device_id].push(entity);
  });

  const usedIds = new Set();

  return (devices || [])
    .map(device => {
      const deviceEntities = entitiesByDevice[device.id] || [];
      if (isVirtualSmartShadeDevice(device)) return null;
      if (!looksLikeSmartShadeDevice(device, deviceEntities)) return null;

      const area = areasById[device.area_id] || null;
      const areaName = area?.name || device.area_id || deviceDisplayName(device);
      const entitiesForRoom = {};

      deviceEntities.forEach(entity => {
        const field = fieldForEntity(entity);
        if (field && !entitiesForRoom[field]) {
          entitiesForRoom[field] = entity.entity_id;
        }
      });

      if (!entitiesForRoom.shade) return null;

      let id = slugify(areaName);
      if (usedIds.has(id)) id = `${id}_${slugify(deviceDisplayName(device))}`;
      usedIds.add(id);

      return {
        id,
        floor: 1,
        name: area?.name || deviceDisplayName(device),
        isPhysical: true,
        deviceId: device.id,
        areaId: device.area_id || null,
        entities: {
          ...entitiesForRoom,
          ...scheduleHelpersForRoom(entitiesForRoom, helperIds, device.area_id, helperEntities)
        }
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function haRegistryRequest({ haWsUrl, haToken }, commands) {
  return new Promise((resolve, reject) => {
    if (!haToken) return resolve({});

    const ws = new WebSocket(haWsUrl);
    const pending = new Map();
    const results = {};
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('HA registry request timeout'));
    }, 10000);

    function doneIfReady() {
      if (pending.size > 0) return;
      clearTimeout(timeout);
      ws.close();
      resolve(results);
    }

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: haToken }));
        return;
      }

      if (msg.type === 'auth_invalid') {
        clearTimeout(timeout);
        ws.close();
        reject(new Error('HA registry auth failed'));
        return;
      }

      if (msg.type === 'auth_ok') {
        commands.forEach((command, index) => {
          const id = index + 1;
          pending.set(id, command.key);
          ws.send(JSON.stringify({ id, type: command.type }));
        });
        return;
      }

      if (msg.type === 'result' && pending.has(msg.id)) {
        const key = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.success) {
          results[key] = msg.result;
        } else {
          console.warn(`HA registry ${key} nije uspio:`, msg.error);
          results[key] = [];
        }
        doneIfReady();
      }
    });

    ws.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function discoverPhysicalRooms({ haWsUrl, haToken }) {
  const registries = await haRegistryRequest({ haWsUrl, haToken }, [
    { key: 'areas', type: 'config/area_registry/list' },
    { key: 'devices', type: 'config/device_registry/list' },
    { key: 'entities', type: 'config/entity_registry/list' }
  ]);

  return buildPhysicalRoomConfigs(
    registries.areas || [],
    registries.devices || [],
    registries.entities || []
  );
}

module.exports = {
  discoverPhysicalRooms
};
