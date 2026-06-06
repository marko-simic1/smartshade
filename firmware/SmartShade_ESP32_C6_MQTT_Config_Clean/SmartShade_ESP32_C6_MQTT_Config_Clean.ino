/*
  SmartShade ESP32-C6 + Home Assistant MQTT + DHT11 + LDR + Servo
  ----------------------------------------------------------------
  Sto radi:
  - Prvo paljenje: ESP32 digne Wi-Fi hotspot "SmartShade-Setup"
  - hotspot, otvoris 192.168.4.1 i upis:
      Wi-Fi SSID
      Wi-Fi lozinku
      MQTT broker adresu
      MQTT port
      MQTT username
      MQTT password
      home_id / room_id / shade_id
  - ESP32 spremi podatke u flash memoriju
  - Spaja se na MQTT broker
  - Salje Home Assistant MQTT discovery konfiguraciju
  - Objavljuje:
      temperaturu DHT11
      vlagu DHT11
      svjetlo LDR
      kisu
      vjetar
      trenutnu poziciju shade/servo
  - Prima iz Home Assistanta:
      OPEN
      CLOSE
      STOP
      set_position 0-100

  Potrebne Arduino biblioteke:
  - WiFiManager by tzapu
  - PubSubClient by Nick O'Leary
  - DHT sensor library by Adafruit
  - Adafruit Unified Sensor
  - ESP32Servo
*/

#include <WiFi.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <PubSubClient.h>

#include <DHT.h>
#include <ESP32Servo.h>

// ============================================================
// PINOVI - ESP32-C6
// ============================================================

#define DHTPIN 4
#define DHTTYPE DHT11

#define LDR_PIN 2
#define SERVO_PIN 6

// BOOT tipka GPIO 9
#define CONFIG_BUTTON_PIN 9

#define WIND_BUTTON_PIN 12
#define RAIN_BUTTON_PIN 13

// ============================================================
// SERVO POSTAVKE
// ============================================================

// 0% shade pozicije = zatvoreno
// 100% shade pozicije = otvoreno
const int SERVO_CLOSED_ANGLE = 0;
const int SERVO_OPEN_ANGLE   = 180;

const int SERVO_FREQUENCY_HZ = 50;

// ESP32Servo tipicni raspon impulsa.
const int SERVO_MIN_US = 500;
const int SERVO_MAX_US = 2400;

// Veca ADC vrijednost znaci mrak, stavi true.
// Veca ADC vrijednost znaci vise svjetla, ostavi false.
const bool LDR_DARK_IS_HIGH = false;

// ============================================================
// SETUP PORTAL I MQTT
// ============================================================

const char* SETUP_AP_SSID = "SmartShade-Setup";
const char* SETUP_AP_PASS = "12345678";

const char* DISCOVERY_PREFIX = "homeassistant";
const int MQTT_BUFFER_SIZE = 4096;

Preferences preferences;
WiFiClient espClient;
PubSubClient mqtt(espClient);

DHT dht(DHTPIN, DHTTYPE);
Servo shadeServo;

// MQTT i identitet se upisuju kroz setup portal.
// home_id, room_id i shade_id nemaju default vrijednosti.
char mqtt_host[64] = "";
char mqtt_port[8]  = "1883";
char mqtt_user[64] = "";
char mqtt_pass[64] = "";

char home_id[32]  = "";
char room_id[32]  = "";
char shade_id[32] = "";

// Sprema se tek nakon sto korisnik prode setup portal s unesenim ID-jevima.
bool identity_configured = false;

// Stanja senzora
float lastTemperature = NAN;
float lastHumidity = NAN;
int lastLdrRaw = 0;
int lastLightLux = 0;

// Stanje covera/serva
int currentPosition = 0;       // 0-100
int targetPosition = 0;        // 0-100
int currentServoAngle = 0;     // 0-180
int lastPublishedPosition = -1;

unsigned long lastSensorPublish = 0;
unsigned long lastDhtRead = 0;

const unsigned long SENSOR_PUBLISH_INTERVAL_MS = 10000;
const unsigned long DHT_MIN_READ_INTERVAL_MS = 2500;

// ============================================================
// STRING / ID HELPERS
// ============================================================

String normalizeIdentifier(const char* input) {
  String s = String(input);
  s.trim();
  s.toLowerCase();

  String out = "";

  for (int i = 0; i < s.length(); i++) {
    char c = s.charAt(i);

    bool isLetter = (c >= 'a' && c <= 'z');
    bool isNumber = (c >= '0' && c <= '9');

    if (isLetter || isNumber || c == '_' || c == '-') {
      out += c;
    } else {
      out += '_';
    }
  }

  return out;
}

void normalizeIdentity() {
  String h = normalizeIdentifier(home_id);
  String r = normalizeIdentifier(room_id);
  String s = normalizeIdentifier(shade_id);

  strlcpy(home_id, h.c_str(), sizeof(home_id));
  strlcpy(room_id, r.c_str(), sizeof(room_id));
  strlcpy(shade_id, s.c_str(), sizeof(shade_id));
}

bool hasRequiredValues() {
  normalizeIdentity();

  return strlen(mqtt_host) > 0 &&
         strlen(home_id) > 0 &&
         strlen(room_id) > 0 &&
         strlen(shade_id) > 0;
}

bool hasSavedRequiredConfig() {
  return identity_configured && hasRequiredValues();
}

String getDeviceId() {
  return String(home_id) + "_" + String(room_id) + "_" + String(shade_id);
}

String getDeviceName() {
  return String("SmartShade ") + String(room_id) + " " + String(shade_id);
}

String baseTopic() {
  return String("smartshade/") + String(home_id) + "/" + String(room_id) + "/" + String(shade_id);
}

String availabilityTopic() {
  return baseTopic() + "/availability";
}

int getMqttPort() {
  int port = atoi(mqtt_port);

  if (port <= 0) {
    port = 1883;
  }

  return port;
}

// ============================================================
// SPREMANJE / UCITAVANJE KONFIGURACIJE
// ============================================================

void loadConfig() {
  preferences.begin("smartshade", true);

  String savedMqttHost = preferences.getString("mqtt_host", "");
  String savedMqttPort = preferences.getString("mqtt_port", "1883");
  String savedMqttUser = preferences.getString("mqtt_user", "");
  String savedMqttPass = preferences.getString("mqtt_pass", "");

  String savedHomeId = preferences.getString("home_id", "");
  String savedRoomId = preferences.getString("room_id", "");
  String savedShadeId = preferences.getString("shade_id", "");
  identity_configured = preferences.getBool("identity_ok", false);

  int savedPosition = preferences.getInt("position", 0);

  preferences.end();

  strlcpy(mqtt_host, savedMqttHost.c_str(), sizeof(mqtt_host));
  strlcpy(mqtt_port, savedMqttPort.c_str(), sizeof(mqtt_port));
  strlcpy(mqtt_user, savedMqttUser.c_str(), sizeof(mqtt_user));
  strlcpy(mqtt_pass, savedMqttPass.c_str(), sizeof(mqtt_pass));

  strlcpy(home_id, savedHomeId.c_str(), sizeof(home_id));
  strlcpy(room_id, savedRoomId.c_str(), sizeof(room_id));
  strlcpy(shade_id, savedShadeId.c_str(), sizeof(shade_id));

  normalizeIdentity();

  if (savedPosition < 0) savedPosition = 0;
  if (savedPosition > 100) savedPosition = 100;

  currentPosition = savedPosition;
  targetPosition = savedPosition;
}

void saveConfig() {
  normalizeIdentity();

  preferences.begin("smartshade", false);

  preferences.putString("mqtt_host", mqtt_host);
  preferences.putString("mqtt_port", mqtt_port);
  preferences.putString("mqtt_user", mqtt_user);
  preferences.putString("mqtt_pass", mqtt_pass);

  preferences.putString("home_id", home_id);
  preferences.putString("room_id", room_id);
  preferences.putString("shade_id", shade_id);

  identity_configured = hasRequiredValues();
  preferences.putBool("identity_ok", identity_configured);

  preferences.end();

  Serial.println("Konfiguracija spremljena.");
}

void savePosition() {
  preferences.begin("smartshade", false);
  preferences.putInt("position", currentPosition);
  preferences.end();
}

void resetAllSettings() {
  Serial.println("Brisem Wi-Fi, MQTT i SmartShade postavke...");

  WiFiManager wm;
  wm.resetSettings();

  preferences.begin("smartshade", false);
  preferences.clear();
  preferences.end();

  delay(1000);
  ESP.restart();
}

void checkConfigResetButton() {
  pinMode(CONFIG_BUTTON_PIN, INPUT_PULLUP);

  if (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
    Serial.println("BOOT tipka pritisnuta. Drzi 5 sekundi za reset postavki...");

    unsigned long startTime = millis();

    while (digitalRead(CONFIG_BUTTON_PIN) == LOW) {
      if (millis() - startTime > 5000) {
        resetAllSettings();
      }

      delay(50);
    }
  }
}

// ============================================================
// WIFI + SETUP PORTAL
// ============================================================

void setupWifiAndConfigPortal() {
  loadConfig();

  WiFi.mode(WIFI_STA);

  WiFiManager wm;
  wm.setConfigPortalTimeout(300);

  WiFiManagerParameter paramHomeId(
    "home_id",
    "Home ID - obavezno",
    home_id,
    sizeof(home_id)
  );

  WiFiManagerParameter paramRoomId(
    "room_id",
    "Room ID - obavezno",
    room_id,
    sizeof(room_id)
  );

  WiFiManagerParameter paramShadeId(
    "shade_id",
    "Shade ID - obavezno",
    shade_id,
    sizeof(shade_id)
  );

  WiFiManagerParameter paramMqttHost(
    "mqtt_host",
    "MQTT broker IP / hostname - obavezno",
    mqtt_host,
    sizeof(mqtt_host)
  );

  WiFiManagerParameter paramMqttPort(
    "mqtt_port",
    "MQTT port, npr. 1883",
    mqtt_port,
    sizeof(mqtt_port)
  );

  WiFiManagerParameter paramMqttUser(
    "mqtt_user",
    "MQTT username",
    mqtt_user,
    sizeof(mqtt_user)
  );

  WiFiManagerParameter paramMqttPass(
    "mqtt_pass",
    "MQTT password",
    mqtt_pass,
    sizeof(mqtt_pass),
    "type='password'"
  );

  wm.addParameter(&paramHomeId);
  wm.addParameter(&paramRoomId);
  wm.addParameter(&paramShadeId);
  wm.addParameter(&paramMqttHost);
  wm.addParameter(&paramMqttPort);
  wm.addParameter(&paramMqttUser);
  wm.addParameter(&paramMqttPass);

  bool configOk = false;

  if (!hasSavedRequiredConfig()) {
    Serial.println("Nedostaje MQTT broker ili SmartShade identitet.");
    Serial.println("Obavezno upisi home_id, room_id i shade_id u setup portalu.");
    Serial.println("Otvaram setup portal...");
    configOk = wm.startConfigPortal(SETUP_AP_SSID, SETUP_AP_PASS);
  } else {
    Serial.println("Pokusavam automatsko spajanje na spremljeni Wi-Fi...");
    configOk = wm.autoConnect(SETUP_AP_SSID, SETUP_AP_PASS);
  }

  if (!configOk) {
    Serial.println("Spajanje/konfiguracija nije uspjela. Restartam ESP32...");
    delay(3000);
    ESP.restart();
  }

  strlcpy(home_id, paramHomeId.getValue(), sizeof(home_id));
  strlcpy(room_id, paramRoomId.getValue(), sizeof(room_id));
  strlcpy(shade_id, paramShadeId.getValue(), sizeof(shade_id));

  strlcpy(mqtt_host, paramMqttHost.getValue(), sizeof(mqtt_host));
  strlcpy(mqtt_port, paramMqttPort.getValue(), sizeof(mqtt_port));
  strlcpy(mqtt_user, paramMqttUser.getValue(), sizeof(mqtt_user));
  strlcpy(mqtt_pass, paramMqttPass.getValue(), sizeof(mqtt_pass));

  normalizeIdentity();

  if (!hasRequiredValues()) {
    Serial.println("Konfiguracija nije potpuna.");
    Serial.println("home_id, room_id, shade_id i MQTT broker su obavezni.");
    Serial.println("Restartam i ponovno otvaram setup portal...");
    delay(3000);
    ESP.restart();
  }

  saveConfig();

  Serial.println();
  Serial.println("Wi-Fi spojen.");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());

  Serial.print("Device ID: ");
  Serial.println(getDeviceId());

  Serial.print("MQTT broker: ");
  Serial.print(mqtt_host);
  Serial.print(":");
  Serial.println(getMqttPort());
}

// ============================================================
// SERVO / COVER
// ============================================================

int positionToServoAngle(int position) {
  if (position < 0) position = 0;
  if (position > 100) position = 100;

  return map(position, 0, 100, SERVO_CLOSED_ANGLE, SERVO_OPEN_ANGLE);
}

void applyServoPosition(int position, bool saveToFlash) {
  if (position < 0) position = 0;
  if (position > 100) position = 100;

  currentPosition = position;
  targetPosition = position;

  currentServoAngle = positionToServoAngle(currentPosition);

  shadeServo.write(currentServoAngle);

  if (saveToFlash) {
    savePosition();
  }

  Serial.print("Servo pozicija: ");
  Serial.print(currentPosition);
  Serial.print("% | kut: ");
  Serial.println(currentServoAngle);
}

void stopServo() {
  // Standardni positional servo nema "stop"
  // Ovdje samo zadrzavamo trenutni kut
  shadeServo.write(currentServoAngle);
  Serial.println("STOP - servo zadrzava trenutnu poziciju");
}

void goToPosition(int position) {
  applyServoPosition(position, true);
}

void openShade() {
  goToPosition(100);
}

void closeShade() {
  goToPosition(0);
}

// ============================================================
// SENZORI
// ============================================================

bool readDhtIfNeeded() {
  unsigned long now = millis();

  if (now - lastDhtRead < DHT_MIN_READ_INTERVAL_MS) {
    return !isnan(lastTemperature) && !isnan(lastHumidity);
  }

  lastDhtRead = now;

  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("Greska DHT11 - preskacem objavu temperature/vlage.");
    return false;
  }

  lastTemperature = temp;
  lastHumidity = hum;

  return true;
}

int readLdrRaw() {
  int raw = analogRead(LDR_PIN);

  if (raw < 0) raw = 0;
  if (raw > 4095) raw = 4095;

  lastLdrRaw = raw;
  return raw;
}

int rawLdrToApproxLux(int raw) {
  int value = raw;

  if (LDR_DARK_IS_HIGH) {
    value = 4095 - raw;
  }

  int lux = map(value, 0, 4095, 0, 1000);

  if (lux < 0) lux = 0;
  if (lux > 1000) lux = 1000;

  return lux;
}

int readLightLuxApprox() {
  int raw = readLdrRaw();
  lastLightLux = rawLdrToApproxLux(raw);
  return lastLightLux;
}


int readWindKmh() {
  bool windButtonPressed = digitalRead(WIND_BUTTON_PIN) == LOW;

  if (windButtonPressed) {
    return 60;   // simulira da puše vjetar
  }

  return 0;      // nema vjetra
}

bool readRainState() {
  bool rainButtonPressed = digitalRead(RAIN_BUTTON_PIN) == LOW;

  return rainButtonPressed;
}

// ============================================================
// MQTT PUBLISH HELPERS
// ============================================================

bool publishRetained(const String& topic, const String& payload) {
  bool ok = mqtt.publish(topic.c_str(), payload.c_str(), true);

  Serial.print(ok ? "MQTT publish OK: " : "MQTT publish FAIL: ");
  Serial.print(topic);
  Serial.print(" -> ");
  Serial.println(payload);

  return ok;
}

void publishAvailabilityOnline() {
  publishRetained(availabilityTopic(), "online");
}

void publishCoverPosition(bool force) {
  if (!mqtt.connected()) {
    return;
  }

  if (force || currentPosition != lastPublishedPosition) {
    publishRetained(baseTopic() + "/cover/position", String(currentPosition));
    lastPublishedPosition = currentPosition;
  }
}

String deviceJson() {
  String id = getDeviceId();
  String name = getDeviceName();

  String payload = "\"device\":{";
  payload += "\"identifiers\":[\"" + id + "\"],";
  payload += "\"name\":\"" + name + "\",";
  payload += "\"manufacturer\":\"SmartShade\",";
  payload += "\"model\":\"ESP32-C6 Smart Shade\"";
  payload += "}";

  return payload;
}

// ============================================================
// HOME ASSISTANT MQTT DISCOVERY
// ============================================================

void publishDiscoverySensor(
  const char* objectSuffix,
  const char* name,
  const String& stateTopic,
  const char* unit,
  const char* deviceClass,
  const char* stateClass
) {
  String id = getDeviceId();
  String uniqueId = id + "_" + String(objectSuffix);

  String configTopic = String(DISCOVERY_PREFIX) + "/sensor/" + uniqueId + "/config";

  String payload = "{";
  payload += "\"name\":\"" + String(name) + "\",";
  payload += "\"unique_id\":\"" + uniqueId + "\",";
  payload += "\"state_topic\":\"" + stateTopic + "\",";
  payload += "\"unit_of_measurement\":\"" + String(unit) + "\",";
  payload += "\"device_class\":\"" + String(deviceClass) + "\",";
  payload += "\"state_class\":\"" + String(stateClass) + "\",";
  payload += "\"availability_topic\":\"" + availabilityTopic() + "\",";
  payload += "\"payload_available\":\"online\",";
  payload += "\"payload_not_available\":\"offline\",";
  payload += deviceJson();
  payload += "}";

  publishRetained(configTopic, payload);
}

void publishRainDiscovery() {
  String id = getDeviceId();
  String uniqueId = id + "_rain";
  String rainStateTopic = baseTopic() + "/weather/rain/state";

  String configTopic = String(DISCOVERY_PREFIX) + "/binary_sensor/" + uniqueId + "/config";

  String payload = "{";
  payload += "\"name\":\"Rain\",";
  payload += "\"unique_id\":\"" + uniqueId + "\",";
  payload += "\"state_topic\":\"" + rainStateTopic + "\",";
  payload += "\"payload_on\":\"ON\",";
  payload += "\"payload_off\":\"OFF\",";
  payload += "\"device_class\":\"moisture\",";
  payload += "\"availability_topic\":\"" + availabilityTopic() + "\",";
  payload += "\"payload_available\":\"online\",";
  payload += "\"payload_not_available\":\"offline\",";
  payload += deviceJson();
  payload += "}";

  publishRetained(configTopic, payload);
}

void publishCoverDiscovery() {
  String id = getDeviceId();
  String uniqueId = id + "_shade";
  String coverCommandTopic = baseTopic() + "/cover/command";
  String coverSetPositionTopic = baseTopic() + "/cover/set_position";
  String coverPositionTopic = baseTopic() + "/cover/position";

  String configTopic = String(DISCOVERY_PREFIX) + "/cover/" + uniqueId + "/config";

  String payload = "{";
  payload += "\"name\":\"Shade\",";
  payload += "\"unique_id\":\"" + uniqueId + "\",";
  payload += "\"command_topic\":\"" + coverCommandTopic + "\",";
  payload += "\"set_position_topic\":\"" + coverSetPositionTopic + "\",";
  payload += "\"position_topic\":\"" + coverPositionTopic + "\",";
  payload += "\"payload_open\":\"OPEN\",";
  payload += "\"payload_close\":\"CLOSE\",";
  payload += "\"payload_stop\":\"STOP\",";
  payload += "\"position_open\":100,";
  payload += "\"position_closed\":0,";
  payload += "\"availability_topic\":\"" + availabilityTopic() + "\",";
  payload += "\"payload_available\":\"online\",";
  payload += "\"payload_not_available\":\"offline\",";
  payload += deviceJson();
  payload += "}";

  publishRetained(configTopic, payload);
}

void publishModeDiscovery() {
  String id = getDeviceId();
  String uniqueId = id + "_mode";
  String modeSetTopic = baseTopic() + "/mode/set";
  String modeStateTopic = baseTopic() + "/mode/state";

  String configTopic = String(DISCOVERY_PREFIX) + "/select/" + uniqueId + "/config";

  String payload = "{";
  payload += "\"name\":\"Mode\",";
  payload += "\"unique_id\":\"" + uniqueId + "\",";
  payload += "\"command_topic\":\"" + modeSetTopic + "\",";
  payload += "\"state_topic\":\"" + modeStateTopic + "\",";
  payload += "\"options\":[\"auto\",\"manual\"],";
  payload += "\"value_template\":\"{{ value | lower }}\",";
  payload += "\"command_template\":\"{{ value | upper }}\",";
  payload += "\"availability_topic\":\"" + availabilityTopic() + "\",";
  payload += "\"payload_available\":\"online\",";
  payload += "\"payload_not_available\":\"offline\",";
  payload += deviceJson();
  payload += "}";

  publishRetained(configTopic, payload);
}

void publishDiscovery() {
  publishDiscoverySensor(
    "temperature",
    "Temperature",
    baseTopic() + "/temperature",
    "°C",
    "temperature",
    "measurement"
  );

  publishDiscoverySensor(
    "light",
    "Light",
    baseTopic() + "/light",
    "lx",
    "illuminance",
    "measurement"
  );

  publishDiscoverySensor(
    "humidity",
    "Humidity",
    baseTopic() + "/humidity",
    "%",
    "humidity",
    "measurement"
  );

  publishDiscoverySensor(
    "wind",
    "Wind",
    baseTopic() + "/weather/wind",
    "km/h",
    "wind_speed",
    "measurement"
  );

  publishRainDiscovery();
  publishCoverDiscovery();
  publishModeDiscovery();
}

// ============================================================
// RUNTIME MQTT STATE PUBLISH
// ============================================================

void publishSensorValues() {
  bool dhtOk = readDhtIfNeeded();

  int lightLux = readLightLuxApprox();
  int windKmh = readWindKmh();
  bool rain = readRainState();

  if (dhtOk) {
    publishRetained(baseTopic() + "/temperature", String(lastTemperature, 1));
    publishRetained(baseTopic() + "/humidity", String(lastHumidity, 1));
  }

  publishRetained(baseTopic() + "/light", String(lightLux));
  publishRetained(baseTopic() + "/weather/wind", String(windKmh));
  publishRetained(baseTopic() + "/weather/rain/state", rain ? "ON" : "OFF");

  publishCoverPosition(true);

  Serial.print("Temp: ");
  if (dhtOk) {
    Serial.print(lastTemperature, 1);
  } else {
    Serial.print("N/A");
  }

  Serial.print(" °C | Vlaga: ");
  if (dhtOk) {
    Serial.print(lastHumidity, 1);
  } else {
    Serial.print("N/A");
  }

  Serial.print(" % | LDR raw: ");
  Serial.print(lastLdrRaw);

  Serial.print(" | Light approx: ");
  Serial.print(lightLux);
  Serial.print(" lx | Shade: ");
  Serial.print(currentPosition);
  Serial.print("% | Servo: ");
  Serial.println(currentServoAngle);
}

// ============================================================
// MQTT CALLBACK - PRIMANJE KOMANDI IZ HOME ASSISTANTA
// ============================================================

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String receivedTopic = String(topic);
  String msg = "";

  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  msg.trim();

  Serial.print("MQTT primljeno: ");
  Serial.print(receivedTopic);
  Serial.print(" -> ");
  Serial.println(msg);

  String base = baseTopic();
  String modeSetTopic = base + "/mode/set";
  String modeStateTopic = base + "/mode/state";
  String coverCommandTopic = base + "/cover/command";
  String coverSetPositionTopic = base + "/cover/set_position";

  if (receivedTopic == modeSetTopic) {
    String mode = msg;
    mode.toUpperCase();

    if (mode == "AUTO" || mode == "MANUAL") {
      publishRetained(modeStateTopic, mode);
    }

    return;
  }

  if (receivedTopic == coverCommandTopic) {
    String command = msg;
    command.toUpperCase();

    if (command == "OPEN") {
      openShade();
    } else if (command == "CLOSE") {
      closeShade();
    } else if (command == "STOP") {
      stopServo();
    }

    publishCoverPosition(true);
    return;
  }

  if (receivedTopic == coverSetPositionTopic) {
    int pos = msg.toInt();

    if (pos < 0) pos = 0;
    if (pos > 100) pos = 100;

    goToPosition(pos);
    publishCoverPosition(true);
    return;
  }
}

// ============================================================
// MQTT SPAJANJE
// ============================================================

void subscribeToCommandTopics() {
  String base = baseTopic();
  String coverCommandTopic = base + "/cover/command";
  String coverSetPositionTopic = base + "/cover/set_position";
  String modeSetTopic = base + "/mode/set";

  mqtt.subscribe(coverCommandTopic.c_str());
  mqtt.subscribe(coverSetPositionTopic.c_str());
  mqtt.subscribe(modeSetTopic.c_str());

  Serial.print("Subscribed: ");
  Serial.println(coverCommandTopic);

  Serial.print("Subscribed: ");
  Serial.println(coverSetPositionTopic);

  Serial.print("Subscribed: ");
  Serial.println(modeSetTopic);
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.println();
    Serial.print("Spajam se na MQTT broker ");
    Serial.print(mqtt_host);
    Serial.print(":");
    Serial.println(getMqttPort());

    String clientId = getDeviceId();

    bool connected = false;

    if (strlen(mqtt_user) > 0) {
      connected = mqtt.connect(
        clientId.c_str(),
        mqtt_user,
        mqtt_pass,
        availabilityTopic().c_str(),
        1,
        true,
        "offline"
      );
    } else {
      connected = mqtt.connect(
        clientId.c_str(),
        availabilityTopic().c_str(),
        1,
        true,
        "offline"
      );
    }

    if (connected) {
      Serial.println("MQTT spojen.");

      publishAvailabilityOnline();

      // Discovery config poruke idu retained.
      publishDiscovery();

      subscribeToCommandTopics();

      publishSensorValues();
      publishCoverPosition(true);

    } else {
      Serial.print("MQTT greska, rc=");
      Serial.println(mqtt.state());
      Serial.println("Pokusavam ponovno za 5 sekundi...");
      delay(5000);
    }
  }
}

// ============================================================
// SETUP / LOOP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("SmartShade ESP32-C6 start");

  checkConfigResetButton();

  // DHT11
  dht.begin();

  // ADC setup za ESP32-C6, 12-bit: 0-4095
  analogReadResolution(12);
  pinMode(LDR_PIN, INPUT);

  // Servo
  shadeServo.setPeriodHertz(SERVO_FREQUENCY_HZ);
  shadeServo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);

  // Ucitaj spremljenu poziciju i postavi servo odmah.
  loadConfig();
  applyServoPosition(currentPosition, false);

  //wind rain tipke
  pinMode(WIND_BUTTON_PIN, INPUT_PULLUP);
  pinMode(RAIN_BUTTON_PIN, INPUT_PULLUP);

  setupWifiAndConfigPortal();

  mqtt.setServer(mqtt_host, getMqttPort());
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(MQTT_BUFFER_SIZE);

  connectMqtt();
}

void loop() {
  checkConfigResetButton();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi veza pukla. Restartam ESP32...");
    delay(3000);
    ESP.restart();
  }

  if (!mqtt.connected()) {
    connectMqtt();
  }

  mqtt.loop();

  unsigned long now = millis();

  if (now - lastSensorPublish >= SENSOR_PUBLISH_INTERVAL_MS) {
    lastSensorPublish = now;
    publishSensorValues();
  }
}
