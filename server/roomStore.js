const roomConfig = {};
const schedules = {};
const roomCache = {};
const entityToRoom = {};

function entitiesFromDeviceId(deviceId) {
  return {
    shade:       `cover.${deviceId}_shade`,
    temperature: `sensor.${deviceId}_temperature`,
    light:       `sensor.${deviceId}_light`,
    humidity:    `sensor.${deviceId}_humidity`,
    wind:        `sensor.${deviceId}_wind`,
    rain:        `binary_sensor.${deviceId}_rain`,
    mode:        `select.${deviceId}_mode`
  };
}

function buildVirtualRoomConfigs() {
  return Array.from({ length: 10 }, (_, i) => {
    const id = String(102 + i);
    const deviceId = `smartshade_room_${id}`;
    return {
      id,
      floor: parseInt(id) <= 105 ? 1 : 2,
      name: `Soba ${id}`,
      isPhysical: false,
      deviceId,
      areaId: null,
      entities: entitiesFromDeviceId(deviceId)
    };
  });
}

function createEmptyRoom(id, cfg, previous = {}) {
  return {
    id,
    name: cfg.name,
    floor: cfg.floor,
    isPhysical: cfg.isPhysical,
    deviceId: cfg.deviceId,
    areaId: cfg.areaId,
    online: previous.online || false,
    position: previous.position || 0,
    temperature: previous.temperature || 0,
    light: previous.light || 0,
    humidity: previous.humidity || 0,
    windSpeed: previous.windSpeed || 0,
    rain: previous.rain || false,
    mode: previous.mode || 'manual',
    lightPreference: 'medium',
    schedule: schedules[id]
  };
}

function replaceRoomConfig(configs) {
  Object.keys(roomConfig).forEach(id => delete roomConfig[id]);
  Object.keys(entityToRoom).forEach(entityId => delete entityToRoom[entityId]);

  configs.forEach(cfg => {
    roomConfig[cfg.id] = cfg;
    schedules[cfg.id] ||= { open: '07:00', close: '22:00' };
    roomCache[cfg.id] = createEmptyRoom(cfg.id, cfg, roomCache[cfg.id]);

    Object.entries(cfg.entities).forEach(([field, entityId]) => {
      if (entityId) entityToRoom[entityId] = { roomId: cfg.id, field };
    });
  });

  Object.keys(roomCache).forEach(id => {
    if (!roomConfig[id]) delete roomCache[id];
  });
}

function initializeVirtualRooms() {
  replaceRoomConfig(buildVirtualRoomConfigs());
}

function hasRoom(roomId) {
  return Boolean(roomConfig[roomId]);
}

function getEntityIds(roomId) {
  return roomConfig[roomId]?.entities || null;
}

function getConfiguredRoomIds() {
  return Object.keys(roomConfig);
}

function getPhysicalRoomConfigs() {
  return Object.values(roomConfig).filter(cfg => cfg.isPhysical);
}

function getCachedRooms(roomIds = null) {
  const ids = roomIds || Object.keys(roomCache);
  return ids.map(id => ({ ...roomCache[id], schedule: schedules[id] })).filter(Boolean);
}

function updateSchedule(roomId, patch) {
  schedules[roomId] = { ...schedules[roomId], ...patch };
  return schedules[roomId];
}

function getGroupShadeTargets(floor) {
  return Object.entries(roomConfig)
    .filter(([, cfg]) => !floor || cfg.floor === floor)
    .map(([id]) => getEntityIds(id).shade)
    .filter(Boolean);
}

function applyEntityState(entityId, newState) {
  const mapping = entityToRoom[entityId];
  if (!mapping) return false;

  const { roomId, field } = mapping;
  const room = roomCache[roomId];
  if (!room) return false;

  const validState = newState &&
    newState.state !== 'unavailable' &&
    newState.state !== 'unknown';

  switch (field) {
    case 'shade':
      room.online = validState;
      if (validState && newState.attributes) {
        const position = parseFloat(newState.attributes.current_position);
        if (Number.isFinite(position)) room.position = position;
      }
      break;
    case 'temperature':
      if (validState) room.temperature = parseFloat(newState.state) || 0;
      break;
    case 'light':
      if (validState) room.light = parseFloat(newState.state) || 0;
      break;
    case 'humidity':
      if (validState) room.humidity = parseFloat(newState.state) || 0;
      break;
    case 'wind':
      if (validState) room.windSpeed = parseFloat(newState.state) || 0;
      break;
    case 'rain':
      room.rain = validState ? newState.state === 'on' : false;
      break;
    case 'mode':
      if (validState) room.mode = newState.state;
      break;
    default:
      return false;
  }
  return true;
}

module.exports = {
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
};
