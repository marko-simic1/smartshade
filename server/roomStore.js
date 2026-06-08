// Store soba svjestan više HA instanci.
// Svaka soba nosi haId (kojem HA instanceu pripada). Globalni id sobe je
// prefiksiran haId-om (npr. "ha1__kitchen") da ne dolazi do kolizija između instanci.
// Reverse mapa entiteta je ključana s `${haId}|${entityId}` jer dva HA-a mogu
// imati identične entity_id-eve (npr. oba cover.smartshade_main_shade).

const roomConfig = {};
const schedules = {};
const roomCache = {};
const entityToRoom = {};

function entityKey(haId, entityId) {
  return `${haId}|${entityId}`;
}

function entitiesFromDeviceId(deviceId) {
  return {
    shade:       `cover.${deviceId}_shade`,
    temperature: `sensor.${deviceId}_temperature`,
    light:       `sensor.${deviceId}_light`,
    humidity:    `sensor.${deviceId}_humidity`,
    wind:        `sensor.${deviceId}_wind`,
    rain:        `binary_sensor.${deviceId}_rain`,
    mode:        `select.${deviceId}_mode`,
    scheduleOpen:  `input_datetime.${deviceId}_morning_open_time`,
    scheduleClose: `input_datetime.${deviceId}_night_closing_time`
  };
}

// 10 virtualnih soba (simulator) za jednu HA instancu
function buildVirtualRoomConfigs(haId, haLabel) {
  return Array.from({ length: 10 }, (_, i) => {
    const localId = String(102 + i);
    const deviceId = `smartshade_room_${localId}`;
    return {
      id: `${haId}__${localId}`,
      haId,
      haLabel,
      floor: parseInt(localId) <= 105 ? 1 : 2,
      name: `Soba ${localId}`,
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
    haId: cfg.haId,
    haLabel: cfg.haLabel,
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
  Object.keys(entityToRoom).forEach(key => delete entityToRoom[key]);

  configs.forEach(cfg => {
    roomConfig[cfg.id] = cfg;
    schedules[cfg.id] ||= { open: '07:00', close: '22:00' };
    roomCache[cfg.id] = createEmptyRoom(cfg.id, cfg, roomCache[cfg.id]);

    Object.entries(cfg.entities).forEach(([field, entityId]) => {
      if (entityId) entityToRoom[entityKey(cfg.haId, entityId)] = { roomId: cfg.id, field };
    });
  });

  Object.keys(roomCache).forEach(id => {
    if (!roomConfig[id]) delete roomCache[id];
  });
}

function hasRoom(roomId) {
  return Boolean(roomConfig[roomId]);
}

function getEntityIds(roomId) {
  return roomConfig[roomId]?.entities || null;
}

function getScheduleEntityIds(roomId) {
  const entities = getEntityIds(roomId);
  if (!entities?.scheduleOpen || !entities?.scheduleClose) return null;
  return {
    open: entities.scheduleOpen,
    close: entities.scheduleClose
  };
}

function getRoomHa(roomId) {
  return roomConfig[roomId]?.haId || null;
}

function getConfiguredRoomIds() {
  return Object.keys(roomConfig);
}

// Room id-evi koji pripadaju jednoj HA instanci (za REST load po instanci)
function getConfiguredRoomIdsByHa(haId) {
  return Object.values(roomConfig).filter(cfg => cfg.haId === haId).map(cfg => cfg.id);
}

function getPhysicalRoomConfigs() {
  return Object.values(roomConfig).filter(cfg => cfg.isPhysical);
}

function getCachedRooms(roomIds = null) {
  const ids = roomIds || Object.keys(roomCache);
  return ids.map(id => roomCache[id] ? { ...roomCache[id], schedule: schedules[id] } : null).filter(Boolean);
}

function updateSchedule(roomId, patch) {
  schedules[roomId] = { ...schedules[roomId], ...patch };
  return schedules[roomId];
}

// Mete za grupno upravljanje — vraća { haId, entityId } jer naredba mora ići u pravi HA
function getGroupShadeTargets(floor) {
  return Object.values(roomConfig)
    .filter(cfg => !floor || cfg.floor === floor)
    .map(cfg => ({ haId: cfg.haId, entityId: cfg.entities.shade }))
    .filter(t => t.entityId);
}

function applyEntityState(haId, entityId, newState) {
  const mapping = entityToRoom[entityKey(haId, entityId)];
  if (!mapping) return false;

  const room = roomCache[mapping.roomId];
  if (!room) return false;

  const validState = newState &&
    newState.state !== 'unavailable' &&
    newState.state !== 'unknown';

  switch (mapping.field) {
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
    case 'scheduleOpen':
      if (validState) room.schedule = { ...schedules[mapping.roomId], open: newState.state.slice(0, 5) };
      schedules[mapping.roomId] = room.schedule;
      break;
    case 'scheduleClose':
      if (validState) room.schedule = { ...schedules[mapping.roomId], close: newState.state.slice(0, 5) };
      schedules[mapping.roomId] = room.schedule;
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
  getConfiguredRoomIdsByHa,
  getEntityIds,
  getGroupShadeTargets,
  getPhysicalRoomConfigs,
  getScheduleEntityIds,
  getRoomHa,
  hasRoom,
  replaceRoomConfig,
  updateSchedule
};
