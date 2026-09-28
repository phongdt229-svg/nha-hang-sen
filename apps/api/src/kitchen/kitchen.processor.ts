import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { KITCHEN_QUEUE } from './kitchen.config';
import { KitchenService, type AckCheckJob } from './kitchen.service';

@Processor(KITCHEN_QUEUE)
export class KitchenProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly kitchen: KitchenService,
    @InjectQueue(KITCHEN_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler('sweep-stale', { every: 15_000 }, { name: 'sweep-stale' });
  }

  async process(job: Job<AckCheckJob>) {
    if (job.name === 'ack-check') return this.kitchen.checkAck(job.data);
    if (job.name === 'sweep-stale') return this.kitchen.sweepStale();
  }
}
