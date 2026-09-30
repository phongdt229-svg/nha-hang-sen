import { RobotBridge } from './bridge';
import { MqttBridgeLink } from './mqtt-link';
import type { LinePort } from './protocol';
import { openSerial } from './serial';
import { VirtualMbot } from './virtual-mbot';

const USAGE = `Robot bridge – mBot v1 demo (Nhà hàng Sen)

Biến môi trường:
  SERIAL      cổng của mBot: COM5 (Windows, cáp USB hoặc Bluetooth), /dev/ttyUSB0, /dev/rfcomm0 (Linux)
              hoặc "virtual" để chạy mBot ảo trên máy (không cần phần cứng)
  MQTT_URL    broker MQTT của server tại quán (mặc định mqtt://localhost:1883)
  ROBOT_ID    mã robot, trùng external_id của robot trên hệ thống (mặc định mbot-01)
  BRANCH_CODE mã chi nhánh (mặc định 001)
  BAUD        tốc độ serial (mặc định 115200, trùng firmware)
  SEGMENT_MS  thời gian mBot ảo chạy giữa hai vạch (mặc định 1500)`;

async function main() {
  const serial = process.env.SERIAL;
  if (!serial) {
    console.log(USAGE);
    process.exit(1);
  }
  const robotId = process.env.ROBOT_ID ?? 'mbot-01';
  const mqttUrl = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
  let port: LinePort;
  if (serial === 'virtual') {
    port = new VirtualMbot({ segmentMs: Number(process.env.SEGMENT_MS ?? 1500) });
    console.log('Chạy mBot ảo (không có phần cứng)');
  } else {
    port = await openSerial(serial, Number(process.env.BAUD ?? 115200));
    console.log(`Đã mở cổng ${serial}`);
  }
  const link = new MqttBridgeLink(mqttUrl, robotId, process.env.BRANCH_CODE ?? '001');
  const bridge = new RobotBridge(link, port, { log: (m) => console.log(`[${robotId}] ${m}`) });
  // In mọi dòng robot gửi lên để căn chỉnh firmware khi dựng sa bàn.
  if (process.env.DEBUG_SERIAL) port.onLine((l) => console.log(`<< ${l}`));
  console.log(`Robot bridge ${robotId} ↔ ${mqttUrl}`);

  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
