"""
SmartShade simulator - simulira 10 virtualnih soba u hotelu.
Salje podatke preko MQTT na web aplikaciju.

Pokretanje: pip install paho-mqtt
           python simulator/rooms_simulator.py
"""

import json
import random
import time

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Instaliraj: pip install paho-mqtt")
    exit(1)

MQTT_BROKER = "test.mosquitto.org"
MQTT_PORT = 1883
BUILDING = "Hotel_Zadar"

rooms = []
for i in range(102, 112):
    floor = 1 if i <= 105 else 2
    rooms.append({
        "id": str(i),
        "floor": floor,
        "temperature": 20 + random.random() * 6,
        "humidity": 40 + random.random() * 20,
        "light": 200 + random.random() * 600,
        "position": random.randint(20, 80),
        "wind_speed": random.uniform(5, 25)
    })

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)


def topic(room_id, msg_type):
    floor = 1 if int(room_id) <= 105 else 2
    return f"smartshade/{BUILDING}/Kat_{floor}/Soba_{room_id}/{msg_type}"


def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Spojeno na MQTT broker: {MQTT_BROKER}")
    for room in rooms:
        t = topic(room["id"], "command")
        client.subscribe(t)
        print(f"Pretplata: {t}")


def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        room_id = msg.topic.split("/Soba_")[1].split("/")[0]
        room = next((r for r in rooms if r["id"] == room_id), None)
        if not room:
            return

        if data.get("action") == "set_position":
            room["position"] = data.get("value", room["position"])
            print(f"Soba {room_id}: Roletne postavljene na {room['position']}%")
    except Exception as e:
        print(f"Greska: {e}")


client.on_connect = on_connect
client.on_message = on_message

try:
    client.connect(MQTT_BROKER, MQTT_PORT, 60)
except Exception as e:
    print(f"Ne mogu se spojiti na MQTT: {e}")
    exit(1)

client.loop_start()
print(f"Simulacija {len(rooms)} soba (102-111)...")
print("Ctrl+C za zaustavljanje\n")

try:
    while True:
        for room in rooms:
            room["temperature"] += (random.random() - 0.5) * 0.5
            room["humidity"] += (random.random() - 0.5) * 2
            room["light"] += (random.random() - 0.5) * 40
            room["wind_speed"] += (random.random() - 0.5) * 3
            room["wind_speed"] = max(0, min(80, room["wind_speed"]))

            # Reakcija na jak vjetar
            if room["wind_speed"] > 40:
                room["position"] = 100
                print(f"Soba {room['id']}: Roletne podignute zbog jakog vjetra ({room['wind_speed']:.0f} km/h)")

            payload = {
                "temperature": round(room["temperature"], 1),
                "humidity": round(room["humidity"], 1),
                "light": round(room["light"]),
                "position": room["position"],
                "wind_speed": round(room["wind_speed"], 1),
                "mode": "auto"
            }

            client.publish(topic(room["id"], "telemetry"), json.dumps(payload))

        time.sleep(5)

except KeyboardInterrupt:
    print("\nSimulator zaustavljen.")
    client.loop_stop()
    client.disconnect()
