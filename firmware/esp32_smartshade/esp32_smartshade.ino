/*
 * SmartShade ESP32 - osnovni firmware
 * 
 * Komponente:
 * - DHT22 (GPIO 4) - temperatura i vlaga
 * - LDR (GPIO 34) - svjetlost
 * - Servo (GPIO 13) - roletne 0-180° = 0-100%
 * - LED (GPIO 2) - crveno = ručni mod
 *
 * WiFi Manager: prvi put se podize hotspot "SmartShade-Setup"
 * Korisnik se spoji i unese SSID/lozinku preko konfiguracijske stranice.
 *
 * Biblioteke (Arduino IDE):
 * - WiFiManager by tzapu
 * - PubSubClient
 * - DHT sensor library
 * - ESP32Servo
 */

#include <WiFi.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>

#define DHT_PIN 4
#define LDR_PIN 34
#define SERVO_PIN 13
#define LED_PIN 2

#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);
Servo blindServo;
WiFiClient espClient;
PubSubClient mqtt(espClient);

const char* MQTT_SERVER = "test.mosquitto.org";
const int MQTT_PORT = 1883;

String deviceId = "101";
String building = "Hotel_Zadar";
int floorNum = 1;

int currentPosition = 50;
String currentMode = "auto";

String telemetryTopic() {
  return "smartshade/" + building + "/Kat_" + String(floorNum) + "/Soba_" + deviceId + "/telemetry";
}

String commandTopic() {
  return "smartshade/" + building + "/Kat_" + String(floorNum) + "/Soba_" + deviceId + "/command";
}

int percentToAngle(int percent) {
  return map(constrain(percent, 0, 100), 0, 100, 0, 180);
}

void setBlindPosition(int percent) {
  currentPosition = constrain(percent, 0, 100);
  blindServo.write(percentToAngle(currentPosition));
}

void setupWiFi() {
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);

  if (!wm.autoConnect("SmartShade-Setup")) {
    Serial.println("WiFi setup neuspješan, restart...");
    ESP.restart();
  }
  Serial.println("WiFi spojen: " + WiFi.localIP().toString());
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  deserializeJson(doc, payload, length);

  const char* action = doc["action"];
  if (!action) return;

  if (strcmp(action, "set_position") == 0) {
    setBlindPosition(doc["value"]);
    currentMode = "manual";
    digitalWrite(LED_PIN, HIGH);
  } else if (strcmp(action, "up") == 0) {
    setBlindPosition(currentPosition + 10);
    currentMode = "manual";
    digitalWrite(LED_PIN, HIGH);
  } else if (strcmp(action, "down") == 0) {
    setBlindPosition(currentPosition - 10);
    currentMode = "manual";
    digitalWrite(LED_PIN, HIGH);
  } else if (strcmp(action, "set_mode") == 0) {
    currentMode = doc["value"];
    digitalWrite(LED_PIN, currentMode == "manual" ? HIGH : LOW);
  }
}

void reconnectMQTT() {
  while (!mqtt.connected()) {
    String clientId = "SmartShade-" + deviceId;
    if (mqtt.connect(clientId.c_str())) {
      mqtt.subscribe(commandTopic().c_str());
      Serial.println("MQTT spojen");
    } else {
      delay(5000);
    }
  }
}

void publishTelemetry() {
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();
  int light = analogRead(LDR_PIN);

  if (isnan(temp)) temp = 0;
  if (isnan(hum)) hum = 0;

  StaticJsonDocument<256> doc;
  doc["temperature"] = temp;
  doc["humidity"] = hum;
  doc["light"] = light;
  doc["position"] = currentPosition;
  doc["mode"] = currentMode;

  char buffer[256];
  serializeJson(doc, buffer);
  mqtt.publish(telemetryTopic().c_str(), buffer);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(LDR_PIN, INPUT);
  digitalWrite(LED_PIN, LOW);

  dht.begin();
  blindServo.attach(SERVO_PIN);
  setBlindPosition(50);

  setupWiFi();

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
}

void loop() {
  if (!mqtt.connected()) reconnectMQTT();
  mqtt.loop();

  publishTelemetry();
  delay(5000);
}
