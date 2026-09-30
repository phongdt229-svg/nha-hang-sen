import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { MbotCommand, MbotLink, MbotMessage } from './mbot-v1';

/**
 * Topic MQTT giữa API và robot bridge (một bridge có thể giữ nhiều mBot):
 *   nhs/{chi_nhanh}/robot/{robotId}/cmd   API → bridge (MbotCommand)
 *   nhs/{chi_nhanh}/robot/{robotId}/msg   bridge → API (MbotMessage; last-will = status offline)
 */
export const mbotTopics = (branch: string, robotId: string) => ({
  cmd: `nhs/${branch}/robot/${robotId}/cmd`,
  msg: `nhs/${branch}/robot/${robotId}/msg`,
});

export class MqttMbotLink implements MbotLink {
  private readonly client: MqttClient;
  private readonly handlers: ((robotId: string, msg: MbotMessage) => void)[] = [];

  constructor(
    url: string,
    private readonly branch = '001',
    options: IClientOptions = {},
  ) {
    this.client = mqtt.connect(url, { reconnectPeriod: 2000, ...options });
    this.client.on('connect', () => this.client.subscribe(`nhs/${branch}/robot/+/msg`, { qos: 1 }));
    this.client.on('message', (topic, payload) => {
      const m = /robot\/([^/]+)\/msg$/.exec(topic);
      if (!m) return;
      let msg: MbotMessage;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      for (const h of this.handlers) h(m[1], msg);
    });
  }

  send(robotId: string, cmd: MbotCommand) {
    return new Promise<void>((resolve, reject) => {
      if (!this.client.connected) return reject(new Error('Mất kết nối MQTT broker'));
      this.client.publish(mbotTopics(this.branch, robotId).cmd, JSON.stringify(cmd), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(handler: (robotId: string, msg: MbotMessage) => void) {
    this.handlers.push(handler);
  }

  async close() {
    await this.client.endAsync();
  }
}
