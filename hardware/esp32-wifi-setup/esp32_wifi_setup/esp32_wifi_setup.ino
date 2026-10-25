

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>   // install "MFRC522" by GithubCommunity from the Library Manager

// RC522 wiring: SDA(SS)=GPIO5, SCK=GPIO18, MOSI=GPIO23, MISO=GPIO19, RST=GPIO22, 3.3V, GND
#define RFID_SS_PIN 5
#define RFID_RST_PIN 22
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);

// ---- Fill these in ----
const char* SERVER_HOST = "https://mediflow-naitik.vercel.app";
const char* DEVICE_ID = "DEV-179ECD";          // from MediFlow > Device Setup
const char* DEVICE_TOKEN = "54a7010f218731c956495182965358be4660b21150edf65a"; // shown once when you add the scanner

// Let's Encrypt root certificate (ISRG Root X1). Copy the PEM from https://letsencrypt.org/certs/isrgrootx1.pem
const char* ISRG_ROOT_X1 = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo
27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w
Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw
TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl
qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH
szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8
Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk
MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92
wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p
aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN
VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb
C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy
h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4
7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J
ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef
MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/
Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT
6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ
0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm
2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb
bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c
-----END CERTIFICATE-----
)EOF";

const char* SETUP_AP_NAME = "MediFlow-Setup";
const char* SETUP_AP_PASS = "mediflow123";
const unsigned long POLL_EVERY_MS = 5000;

Preferences prefs;
WebServer portal(80);
bool portalMode = false;
unsigned long lastPoll = 0;
String savedSsid, savedPass;

// ---------- Wi-Fi ----------
bool connectWifi(const String& ssid, const String& pass, unsigned long timeoutMs = 20000) {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) delay(250);
  return WiFi.status() == WL_CONNECTED;
}

void saveWifi(const String& ssid, const String& pass) {
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  savedSsid = ssid;
  savedPass = pass;
}

// ---------- Setup network (no saved Wi-Fi, or it failed) ----------
String networkOptionsHtml() {
  String html;
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    String s = WiFi.SSID(i);
    html += "<label style='display:block;padding:8px 0;border-bottom:1px solid #ddd'><input type='radio' name='ssid' value='" + s + "'> " + s + " (" + String(WiFi.RSSI(i)) + " dBm)</label>";
  }
  return html;
}

void startSetupPortal() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(SETUP_AP_NAME, SETUP_AP_PASS);
  portal.on("/", []() {
    String page = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>MediFlow setup</title></head>"
                  "<body style='font-family:sans-serif;padding:16px'><h2>MediFlow scanner setup</h2><form method='POST' action='/save'>" +
                  networkOptionsHtml() +
                  "<p>Wi-Fi password: <input type='password' name='pass'></p><button type='submit'>Save and connect</button></form></body></html>";
    portal.send(200, "text/html", page);
  });
  portal.on("/save", HTTP_POST, []() {
    String ssid = portal.arg("ssid");
    String pass = portal.arg("pass");
    if (ssid.length() == 0) { portal.send(400, "text/plain", "Choose a network."); return; }
    saveWifi(ssid, pass);
    portal.send(200, "text/html", "<p>Saved. The scanner is restarting and will connect to " + ssid + ".</p>");
    delay(1500);
    ESP.restart();
  });
  portal.begin();
  portalMode = true;
  Serial.println("Setup network started: " + String(SETUP_AP_NAME) + " — open http://192.168.4.1");
}

// ---------- Talking to MediFlow ----------
bool serverRequestGet(const String& path, String& body) {
  WiFiClientSecure client;
  client.setCACert(ISRG_ROOT_X1);
  HTTPClient http;
  http.begin(client, String(SERVER_HOST) + path);
  http.addHeader("x-device-token", DEVICE_TOKEN);
  int code = http.GET();
  Serial.println("poll -> HTTP " + String(code) + (code < 0 ? " (" + http.errorToString(code) + ")" : ""));
  if (code == 200) body = http.getString();
  http.end();
  return code == 200;
}

bool serverRequestPost(const String& path, const String& json) {
  WiFiClientSecure client;
  client.setCACert(ISRG_ROOT_X1);
  HTTPClient http;
  http.begin(client, String(SERVER_HOST) + path);
  http.addHeader("content-type", "application/json");
  int code = http.POST(json);
  Serial.println("report -> HTTP " + String(code) + (code < 0 ? " (" + http.errorToString(code) + ")" : ""));
  http.end();
  return code == 200;
}

void reportNetworks() {
  int n = WiFi.scanNetworks();
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["token"] = DEVICE_TOKEN;
  doc["currentSsid"] = WiFi.SSID();
  JsonArray arr = doc["networks"].to<JsonArray>();
  for (int i = 0; i < n && i < 30; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  String out;
  serializeJson(doc, out);
  serverRequestPost("/api/device/report", out);
}

void reportStatus(const String& status) {
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["token"] = DEVICE_TOKEN;
  doc["status"] = status;
  String out;
  serializeJson(doc, out);
  serverRequestPost("/api/device/report", out);
}

// ---------- Card reading ----------
// Runs on its own core (see setup), so the card reader is checked all the time, even while the
// scanner is busy talking to MediFlow. Before this, the card was only checked between network
// calls, so most taps were missed.
volatile bool cardWaiting = false;   // true while a card ID is waiting to be sent
String cardUid = "";                 // the waiting card ID

void readCardTask(void* param) {
  String lastUid = "";
  unsigned long lastAt = 0;
  for (;;) {
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
      String uid = "";
      for (byte i = 0; i < rfid.uid.size; i++) {
        if (rfid.uid.uidByte[i] < 0x10) uid += "0";
        uid += String(rfid.uid.uidByte[i], HEX);
      }
      uid.toUpperCase();
      rfid.PICC_HaltA();
      rfid.PCD_StopCrypto1();
      unsigned long now = millis();
      // the same card is ignored for 2 seconds; a new card is kept until the last one is sent
      if (!cardWaiting && !(uid == lastUid && now - lastAt < 2000)) {
        cardUid = uid;
        cardWaiting = true;
        lastUid = uid;
        lastAt = now;
        Serial.println("card -> " + uid);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// Sends the waiting card ID to MediFlow. Called from loop, where network calls are allowed.
void sendPendingCard() {
  if (!cardWaiting) return;
  String uid = cardUid;
  cardWaiting = false;
  JsonDocument doc;
  doc["deviceId"] = DEVICE_ID;
  doc["token"] = DEVICE_TOKEN;
  doc["cardId"] = uid;
  String out;
  serializeJson(doc, out);
  serverRequestPost("/api/device/card", out);
}

void pollServer() {
  String body;
  if (!serverRequestGet(String("/api/device/poll?deviceId=") + DEVICE_ID, body)) return;

  JsonDocument doc;
  if (deserializeJson(doc, body)) return;

  if (doc["scan"].as<bool>()) reportNetworks();

  if (!doc["connect"].isNull()) {
    String ssid = doc["connect"]["ssid"].as<String>();
    String pass = doc["connect"]["password"].as<String>();
    if (connectWifi(ssid, pass)) {
      saveWifi(ssid, pass);
      JsonDocument ok;
      ok["deviceId"] = DEVICE_ID;
      ok["token"] = DEVICE_TOKEN;
      ok["connectApplied"] = true;
      ok["currentSsid"] = ssid;
      String out;
      serializeJson(ok, out);
      serverRequestPost("/api/device/report", out);
    } else {
      reportStatus("could not connect to " + ssid + " — check the password, or choose again");
      connectWifi(savedSsid, savedPass);   // go back to the last working network
    }
  }
}

// ---------- Arduino entry points ----------
void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  // card reader on core 0; WiFi and the server on core 1 (loop)
  xTaskCreatePinnedToCore(readCardTask, "rfid", 4096, NULL, 1, NULL, 0);
  prefs.begin("mediflow", false);
  savedSsid = prefs.getString("ssid", "");
  savedPass = prefs.getString("pass", "");

  if (savedSsid.length() > 0 && connectWifi(savedSsid, savedPass)) {
    Serial.println("Connected to " + savedSsid);
  } else {
    startSetupPortal();
  }
}

void loop() {
  if (portalMode) {
    portal.handleClient();
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi(savedSsid, savedPass);   // keep trying the remembered network
    return;
  }
  sendPendingCard();
  if (millis() - lastPoll > POLL_EVERY_MS) {
    lastPoll = millis();
    pollServer();
  }
}