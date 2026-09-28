import type { RobotEvent } from './adapter';

export class Emitter {
  private readonly handlers: ((e: RobotEvent) => void)[] = [];
  on(h: (e: RobotEvent) => void) {
    this.handlers.push(h);
  }
  emit(e: Omit<RobotEvent, 'at'>) {
    const full = { ...e, at: Date.now() };
    for (const h of this.handlers) {
      try {
        h(full);
      } catch {
        /* một handler lỗi không được làm hỏng adapter */
      }
    }
  }
}
