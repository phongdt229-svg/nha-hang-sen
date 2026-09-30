import { mbotTopics, type MbotCommand, type MbotMessage } from '@nhs/robot-adapters';
import mqtt, { type MqttClient } from 'mqtt';
import type { BridgeLink } from './bridge';

/** Phía bridge của kênh MQTT (xem mbotTopics). Last-will: laptop mất mạng → API thấy robot offline ngay. */
export class MqttBridgeLink implements BridgeLink {
  private readonly client: MqttClient;
  private readonly topics: { cmd: string; msg: string };
  private readonly handlers: ((cmd: MbotCommand) => void)[] = [];

  constructor(url: string, robotId: string, branch = '001') {
    this.topics = mbotTopics(branch, robotId);
    const offline: MbotMessage = { type: 'status', online: false, stop: null, mode: 'IDLE', battery: 0, batterySimulated: true, taskId: null, target: null };
    this.client = mqtt.connect(url, {
      reconnectPeriod: 2000,
      will: { topic: this.topics.msg, payload: Buffer.from(JSON.stringify(offline)), qos: 1, retain: false },
    });
    this.client.on('connect', () => this.client.subscribe(this.topics.cmd, { qos: 1 }));
    this.client.on('message', (_topic, payload) => {
      let cmd: MbotCommand;
      try {
        cmd = JSON.parse(payload.toString());
      } catch {
        return;
      }
      for (const h of this.handlers) h(cmd);
    });
  }

  get connected() {
    return this.client.connected;
  }

  publish(msg: MbotMessage) {
    if (this.client.connected) this.client.publish(this.topics.msg, JSON.stringify(msg), { qos: msg.type === 'status' ? 0 : 1 });
  }

  onCommand(handler: (cmd: MbotCommand) => void) {
    this.handlers.push(handler);
  }

  async close() {
    await this.client.endAsync();
  }
}
