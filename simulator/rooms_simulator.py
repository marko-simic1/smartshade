"""
SmartShade simulator - simulira 10 virtualnih soba (102-111).

Arhitektura: simulator -> MQTT broker -> Home Assistant -> Web aplikacija

Simulator SAMO šalje podatke senzora. Home Assistant je odgovoran za
automatizacije (npr. podizanje roletni zbog jakog vjetra, noćni mod, itd.)

Pokretanje:
    pip install paho-mqtt python-dotenv
    python simulator/rooms_simulator.py
"""

import json
import random
import time
import os

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Instaliraj: pip install paho-mqtt")
    exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

MQTT_BROKER = os.getenv("MQTT_BROKER", "test.mosquitto.org")
MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
HOME_ID     = "home_1"
SHADE_ID    = "shade_1"

rooms = []
for i in range(102, 112):
    floor = 1 if i <= 105 else 2
    room_id = f"room_{i}"
    device_id = f"smartshade_room_{i}"
    rooms.append({
        "id": str(i),
        "room_id": room_id,
        "device_id": device_id,
        "floor": floor,
        "temperature": 20.0 + random.random() * 6,
        "humidity": 40.0 + random.random() * 20,
        "light": 200.0 + random.random() * 600,
        "position": random.randint(20, 80),
        "wind_speed": random.uniform(5, 25),
        "rain": False,
        "mode": "auto"
    })


def state_topic(room, sensor):
    return f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}/{sensor}"


def discovery_topic(room, component, suffix="config"):
    return f"homeassistant/{component}/{room['device_id']}_{suffix.replace('config','')}/{suffix}".replace("//", "/")


def publish_discovery(client, room):
    """Publish MQTT Discovery configs so HA auto-creates entities for this room."""
    d = room["device_id"]
    r = room["room_id"]
    base = f"smartshade/{HOME_ID}/{r}/{SHADE_ID}"
    avail_topic = f"{base}/availability"

    device_block = {
        "identifiers": [d],
        "name": f"SmartShade {room['id']}",
        "manufacturer": "SmartShade",
        "model": "Virtual Room Simulator"
    }

    configs = [
        (
            f"homeassistant/sensor/{d}_temperature/config",
            {
                "name": "Temperature",
                "unique_id": f"{d}_temperature",
                "state_topic": f"{base}/temperature",
                "unit_of_measurement": "°C",
                "device_class": "temperature",
                "state_class": "measurement",
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/sensor/{d}_light/config",
            {
                "name": "Light",
                "unique_id": f"{d}_light",
                "state_topic": f"{base}/light",
                "unit_of_measurement": "lx",
                "device_class": "illuminance",
                "state_class": "measurement",
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/sensor/{d}_humidity/config",
            {
                "name": "Humidity",
                "unique_id": f"{d}_humidity",
                "state_topic": f"{base}/humidity",
                "unit_of_measurement": "%",
                "device_class": "humidity",
                "state_class": "measurement",
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/sensor/{d}_wind/config",
            {
                "name": "Wind",
                "unique_id": f"{d}_wind",
                "state_topic": f"{base}/weather/wind",
                "unit_of_measurement": "km/h",
                "device_class": "wind_speed",
                "state_class": "measurement",
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/binary_sensor/{d}_rain/config",
            {
                "name": "Rain",
                "unique_id": f"{d}_rain",
                "state_topic": f"{base}/weather/rain/state",
                "payload_on": "ON",
                "payload_off": "OFF",
                "device_class": "moisture",
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/cover/{d}_shade/config",
            {
                "name": "Shade",
                "unique_id": f"{d}_shade",
                "command_topic": f"{base}/cover/command",
                "set_position_topic": f"{base}/cover/set_position",
                "position_topic": f"{base}/cover/position",
                "payload_open": "OPEN",
                "payload_close": "CLOSE",
                "payload_stop": "STOP",
                "position_open": 100,
                "position_closed": 0,
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        ),
        (
            f"homeassistant/select/{d}_mode/config",
            {
                "name": "Mode",
                "unique_id": f"{d}_mode",
                "command_topic": f"{base}/mode/set",
                "state_topic": f"{base}/mode/state",
                "options": ["auto", "manual"],
                "availability_topic": avail_topic,
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block
            }
        )
    ]

    for topic, payload in configs:
        client.publish(topic, json.dumps(payload), retain=True)
        print(f"  Discovery: {topic}")


def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Spojeno na MQTT broker: {MQTT_BROKER}:{MQTT_PORT}")

    for room in rooms:
        base = f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}"

        client.subscribe(f"{base}/cover/command")
        client.subscribe(f"{base}/cover/set_position")
        client.subscribe(f"{base}/mode/set")

    print("Objavljivanje MQTT Discovery konfiguracija...")
    for room in rooms:
        publish_discovery(client, room)

    for room in rooms:
        avail_topic = f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}/availability"
        client.publish(avail_topic, "online", retain=True)


def on_message(client, userdata, msg):
    try:
        topic_parts = msg.topic.split("/")
        if len(topic_parts) < 5:
            return
        room_id_str = topic_parts[2]
        room_num = room_id_str.replace("room_", "")
        room = next((r for r in rooms if r["id"] == room_num), None)
        if not room:
            return

        subtopic = "/".join(topic_parts[4:])
        payload = msg.payload.decode()

        if subtopic == "cover/command":
            if payload == "OPEN":
                room["position"] = 100
                print(f"Soba {room_num}: OPEN -> pozicija 100%")
            elif payload == "CLOSE":
                room["position"] = 0
                print(f"Soba {room_num}: CLOSE -> pozicija 0%")
            elif payload == "STOP":
                print(f"Soba {room_num}: STOP")

        elif subtopic == "cover/set_position":
            pos = int(float(payload))
            room["position"] = max(0, min(100, pos))
            print(f"Soba {room_num}: set_position -> {room['position']}%")

        elif subtopic == "mode/set":
            room["mode"] = payload
            print(f"Soba {room_num}: mode -> {payload}")

        base = f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}"
        client.publish(f"{base}/cover/position", str(room["position"]))
        client.publish(f"{base}/mode/state", room["mode"])

    except Exception as e:
        print(f"Greška pri obradi poruke: {e}")


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.on_connect = on_connect
client.on_message = on_message

try:
    client.connect(MQTT_BROKER, MQTT_PORT, 60)
except Exception as e:
    print(f"Ne mogu se spojiti na MQTT broker {MQTT_BROKER}:{MQTT_PORT}: {e}")
    exit(1)

client.loop_start()
print(f"Simulator {len(rooms)} virtualnih soba (102-111) pokrenut...")
print(f"MQTT broker: {MQTT_BROKER}:{MQTT_PORT}")
print("Ctrl+C za zaustavljanje\n")

try:
    while True:
        for room in rooms:
            room["temperature"] = max(15.0, min(35.0, room["temperature"] + (random.random() - 0.5) * 0.5))
            room["humidity"]    = max(20.0, min(90.0, room["humidity"]    + (random.random() - 0.5) * 2.0))
            room["light"]       = max(0.0,  min(2000.0, room["light"]     + (random.random() - 0.5) * 40.0))
            room["wind_speed"]  = max(0.0,  min(80.0,   room["wind_speed"] + (random.random() - 0.5) * 3.0))

            if random.random() < 0.01:
                room["rain"] = not room["rain"]

            base = f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}"

            client.publish(f"{base}/temperature",       str(round(room["temperature"], 1)))
            client.publish(f"{base}/humidity",          str(round(room["humidity"], 1)))
            client.publish(f"{base}/light",             str(round(room["light"])))
            client.publish(f"{base}/weather/wind",      str(round(room["wind_speed"], 1)))
            client.publish(f"{base}/weather/rain/state", "ON" if room["rain"] else "OFF")
            client.publish(f"{base}/cover/position",    str(room["position"]))
            client.publish(f"{base}/mode/state",        room["mode"])

        time.sleep(5)

except KeyboardInterrupt:
    print("\nOznačavanje soba kao offline...")
    for room in rooms:
        avail_topic = f"smartshade/{HOME_ID}/{room['room_id']}/{SHADE_ID}/availability"
        client.publish(avail_topic, "offline", retain=True)
    time.sleep(1)
    print("Simulator zaustavljen.")
    client.loop_stop()
    client.disconnect()
