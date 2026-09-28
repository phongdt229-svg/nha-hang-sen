import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ManualAdapter,
  MqttToyAdapter,
  OrionStarAdapter,
  SimulatedAdapter,
  type RobotAdapter,
  type RobotEvent,
} from '@nhs/robot-adapters';
import type { RobotVendor } from '@prisma/client';

/** Hệ số tốc độ robot giả lập: 1 = như thật (vài giây/chuyến), nhỏ hơn để chạy test nhanh. */
const speed = () => Number(process.env.SIM_SPEED ?? 1);

/** Giữ một adapter cho mỗi loại robot và gom sự kiện của tất cả về một chỗ. */
@Injectable()
export class RobotRegistry implements OnModuleDestroy {
  private readonly logger = new Logger('Robots');
  readonly sim = new SimulatedAdapter({
    toPickupMs: 2500 * speed(),
    travelMs: (ban) => (4000 + (Number(ban.replace(/\D/g, '')) % 12) * 400) * speed(),
    returnMs: 3000 * speed(),
    tickMs: Math.max(20, 400 * speed()),
    autoConfirmMs: Number(process.env.SIM_AUTO_CONFIRM_MS ?? 0),
  });
  readonly manual = new ManualAdapter();
  readonly orion = new OrionStarAdapter(null);
  private mqtt: MqttToyAdapter | null = null;
  private readonly handlers: ((vendor: RobotVendor, e: RobotEvent) => void)[] = [];

  constructor() {
    this.sim.onSuKien((e) => this.dispatch('SIMULATED', e));
    this.manual.onSuKien((e) => this.dispatch('MANUAL', e));
    this.orion.onSuKien((e) => this.dispatch('ORIONSTAR', e));
    if (process.env.MQTT_URL) {
      this.mqtt = new MqttToyAdapter(process.env.MQTT_URL);
      this.mqtt.onSuKien((e) => this.dispatch('MQTT', e));
      this.logger.log(`Kết nối MQTT ${process.env.MQTT_URL}`);
    }
  }

  private dispatch(vendor: RobotVendor, e: RobotEvent) {
    for (const h of this.handlers) h(vendor, e);
  }

  onEvent(h: (vendor: RobotVendor, e: RobotEvent) => void) {
    this.handlers.push(h);
  }

  adapter(vendor: RobotVendor): RobotAdapter {
    switch (vendor) {
      case 'SIMULATED':
        return this.sim;
      case 'MANUAL':
        return this.manual;
      case 'ORIONSTAR':
        return this.orion;
      case 'MQTT':
        if (!this.mqtt) throw new Error('Chưa cấu hình MQTT_URL cho robot MQTT');
        return this.mqtt;
    }
  }

  async onModuleDestroy() {
    await this.sim.close();
    await this.mqtt?.close();
  }
}
