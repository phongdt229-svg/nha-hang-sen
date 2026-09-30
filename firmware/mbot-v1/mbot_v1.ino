/*
 * Firmware mBot v1 (Makeblock mCore) cho sa bàn demo robot giao món – Nhà hàng Sen (tài liệu v0.7, MB-05).
 *
 * Sa bàn A1 (docs/sa-ban-demo-robot-A1.pdf): đường chạy đen rộng 20 mm, chạy một chiều theo chiều kim đồng hồ.
 *   Vạch đôi ở BẾP = vị trí gốc = vạch 0; vạch 1–4 = BÀN 1–4; vạch 5 = TRẠM SẠC. Vạch dừng 15 × 64 mm cắt ngang đường.
 *
 * Cách đếm vạch với cảm biến dò line 2 mắt: robot BÁM MÉP PHẢI của đường (mắt trái trên nền đen, mắt phải
 * trên nền trắng). Vạch dừng cắt ngang làm CẢ HAI mắt cùng đen trong một khoảng thời gian → tính một vạch.
 * Hai vạch sát nhau (vạch đôi) → đang ở BẾP, đặt lại bộ đếm = 0 (tự sửa nếu lỡ đếm sót).
 *
 * Giao tiếp: Serial 115200 qua cáp USB hoặc module Bluetooth, giao thức dòng ASCII — xem
 * apps/robot-bridge/src/protocol.ts (robot bridge dịch sang MQTT cho API).
 *
 * Phần cứng (bộ mBot v1 tiêu chuẩn): Me Line Follower ở PORT_2, Me Ultrasonic ở PORT_3, 2 động cơ M1/M2,
 * nút trên mCore (A7), 2 LED RGB trên bo mạch, còi. mCore không đo được pin → gửi mV = -1 (bridge giả lập pin).
 *
 * Thư viện: Makeblock-Libraries (MeMCore.h). Board: Arduino/Genuino Uno.
 */
#include <MeMCore.h>

// ───── Căn chỉnh theo sa bàn và robot thực tế ─────
#define STOPS 6               // vạch 0..5
#define SPEED_BASE 110        // tốc độ chạy thẳng (0–255)
#define SPEED_TURN 70         // chênh lệch khi bẻ lái
#define MARK_MIN_MS 90        // cả hai mắt đen liên tục ít nhất chừng này mới tính là vạch (lọc nhiễu lúc lệch line)
#define MARK_END_MS 40        // hết đen chừng này thì coi là đã qua vạch
#define DOUBLE_WINDOW_MS 700  // hai vạch cách nhau dưới khoảng này = vạch đôi ở BẾP
#define LOST_MS 2500          // cả hai mắt trắng quá lâu = mất line, tự dừng
#define OBSTACLE_CM 8         // vật cản gần hơn → dừng, báo OBS
#define CLEAR_CM 14           // xa hơn liên tục CLEAR_MS → báo CLR
#define CLEAR_MS 800
#define STATUS_MS 1000
#define FW_VERSION "1.0"

MeDCMotor motorL(M1);
MeDCMotor motorR(M2);
MeLineFollower line(PORT_2);
MeUltrasonicSensor sonar(PORT_3);
MeRGBLed led(0, 2);
MeBuzzer buzzer;

enum Mode { IDLE, MOVING, PAUSED, OBSTACLE, STOPPED };
Mode mode = IDLE;
int stopCount = 0;     // vạch hiện tại (0 = BẾP / vị trí gốc)
int target = -1;       // vạch đích, -1 = không có
bool skipNextMark = false;  // dừng ở vạch đầu của vạch đôi → vạch thứ hai lúc khởi hành không tính

unsigned long blackSince = 0, lastBlackSeen = 0, whiteSince = 0, lastMarkAt = 0;
bool inMark = false, markCounted = false;
unsigned long lastStatus = 0, lastSonar = 0, clearSince = 0;
bool buttonDown = false;

char buf[32];
byte bufLen = 0;

void setColor(byte r, byte g, byte b) {
  led.setColor(0, r, g, b);
  led.show();
}

void motors(int left, int right) {
  // Trên mBot, động cơ trái lắp ngược chiều.
  motorL.run(-left);
  motorR.run(right);
}

void halt() { motors(0, 0); }

void sendStatus() {
  char m = mode == MOVING ? 'M' : mode == PAUSED ? 'P' : mode == OBSTACLE ? 'O' : mode == STOPPED ? 'S' : 'I';
  Serial.print(F("ST "));
  Serial.print(stopCount);
  Serial.print(' ');
  Serial.print(m);
  Serial.println(F(" -1"));
}

void arrive() {
  halt();
  mode = IDLE;
  target = -1;
  if (stopCount == 0) skipNextMark = true;
  Serial.print(F("ARR "));
  Serial.println(stopCount);
  setColor(0, 60, 0);
  buzzer.tone(1047, 120);
  buzzer.tone(1319, 160);
}

void startMoving() {
  if (target < 0) return;
  if (target == stopCount) {
    arrive();
    return;
  }
  mode = MOVING;
  whiteSince = 0;
  setColor(0, 0, 60);
}

/** Một vạch vừa được đếm. */
void onMark() {
  unsigned long now = millis();
  if (skipNextMark) {
    skipNextMark = false;
    lastMarkAt = now;
    return;
  }
  if (now - lastMarkAt < DOUBLE_WINDOW_MS) {
    stopCount = 0;  // vạch thứ hai của vạch đôi: chắc chắn đang ở BẾP
  } else {
    stopCount = (stopCount + 1) % STOPS;
  }
  lastMarkAt = now;
  if (stopCount == target) {
    // Về gốc: dừng ở vạch đầu của vạch đôi; vạch thứ hai sẽ bỏ qua khi khởi hành.
    arrive();
  } else {
    Serial.print(F("PASS "));
    Serial.println(stopCount);
  }
}

/** Bám mép phải của đường; phát hiện vạch dừng. */
void followLine() {
  unsigned long now = millis();
  int s = line.readSensors();  // S1 = mắt trái, S2 = mắt phải; IN = trên nền đen
  bool bothBlack = s == S1_IN_S2_IN;

  if (bothBlack) {
    if (!inMark) {
      inMark = true;
      markCounted = false;
      blackSince = now;
    }
    lastBlackSeen = now;
    if (!markCounted && now - blackSince >= MARK_MIN_MS) {
      markCounted = true;
      onMark();
      if (mode != MOVING) return;
    }
  } else if (inMark && now - lastBlackSeen >= MARK_END_MS) {
    inMark = false;
  }

  switch (s) {
    case S1_IN_S2_OUT:  // đúng mép: chạy thẳng
      whiteSince = 0;
      motors(SPEED_BASE, SPEED_BASE);
      break;
    case S1_IN_S2_IN:  // lệch trái (hoặc đang qua vạch): bẻ nhẹ sang phải
      whiteSince = 0;
      motors(SPEED_BASE, SPEED_BASE - SPEED_TURN / 2);
      break;
    case S1_OUT_S2_OUT:  // lệch phải ra ngoài line: bẻ trái
      if (!whiteSince) whiteSince = now;
      motors(SPEED_BASE - SPEED_TURN, SPEED_BASE);
      if (now - whiteSince > LOST_MS) {
        halt();
        mode = STOPPED;
        setColor(60, 0, 0);
        Serial.println(F("LOST"));
      }
      break;
    default:  // S1_OUT_S2_IN: đã vượt sang bên trái đường, bẻ phải mạnh
      whiteSince = 0;
      motors(SPEED_BASE, SPEED_BASE - SPEED_TURN);
      break;
  }
}

void checkSonar() {
  unsigned long now = millis();
  if (now - lastSonar < 60) return;
  lastSonar = now;
  double cm = sonar.distanceCm();
  if (mode == MOVING && cm > 0 && cm < OBSTACLE_CM) {
    halt();
    mode = OBSTACLE;
    clearSince = 0;
    setColor(60, 30, 0);
    Serial.println(F("OBS"));
  } else if (mode == OBSTACLE) {
    if (cm <= 0 || cm > CLEAR_CM) {
      if (!clearSince) clearSince = now;
      if (now - clearSince > CLEAR_MS) {
        mode = IDLE;  // chờ hệ thống gửi lại lệnh G để đi tiếp (retry của Delivery Service)
        Serial.println(F("CLR"));
      }
    } else {
      clearSince = 0;
    }
  }
}

void checkButton() {
  bool down = analogRead(A7) < 10;
  if (down && !buttonDown) {
    Serial.println(F("BTN"));
    buzzer.tone(1568, 80);
  }
  buttonDown = down;
}

/** Xử lý một dòng lệnh từ bridge. */
void handle(char *cmd) {
  char *op = strtok(cmd, " ");
  if (!op) return;
  char *a = strtok(NULL, " ");
  char *b = strtok(NULL, " ");
  switch (op[0]) {
    case 'G': {
      int stop = a ? atoi(a) : -1;
      if (!a || !b || stop < 0 || stop >= STOPS) {
        Serial.print(F("ERR "));
        Serial.print(b ? b : "0");
        Serial.println(F(" vach-khong-hop-le"));
        return;
      }
      Serial.print(F("OK "));
      Serial.println(b);
      target = stop;
      startMoving();
      break;
    }
    case 'S':
      halt();
      mode = STOPPED;
      setColor(60, 0, 0);
      Serial.print(F("OK "));
      Serial.println(a);
      break;
    case 'P':
      halt();
      if (mode == MOVING) mode = PAUSED;
      Serial.print(F("OK "));
      Serial.println(a);
      break;
    case 'R':
      Serial.print(F("OK "));
      Serial.println(a);
      if (target >= 0) startMoving();
      break;
    case 'C':
      halt();
      target = -1;
      mode = IDLE;
      setColor(0, 0, 0);
      Serial.print(F("OK "));
      Serial.println(a);
      break;
    case 'Q':
      sendStatus();
      break;
  }
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (bufLen) {
        buf[bufLen] = 0;
        handle(buf);
        bufLen = 0;
      }
    } else if (bufLen < sizeof(buf) - 1) {
      buf[bufLen++] = c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  led.setpin(13);
  setColor(0, 0, 0);
  halt();
  // Đặt robot ngay SAU vạch đôi ở BẾP (phía BÀN 1), mũi hướng theo chiều chạy: bộ đếm = 0.
  stopCount = 0;
  buzzer.tone(988, 100);
  Serial.print(F("HELLO MBOT_V1 "));
  Serial.println(F(FW_VERSION));
}

void loop() {
  readSerial();
  checkButton();
  checkSonar();
  if (mode == MOVING) followLine();
  unsigned long now = millis();
  if (now - lastStatus >= STATUS_MS) {
    lastStatus = now;
    sendStatus();
  }
}
