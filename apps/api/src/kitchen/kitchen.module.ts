import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { KITCHEN_QUEUE } from './kitchen.config';
import { KitchenController } from './kitchen.controller';
import { KitchenProcessor } from './kitchen.processor';
import { KitchenService } from './kitchen.service';

@Module({
  imports: [BullModule.registerQueue({ name: KITCHEN_QUEUE })],
  controllers: [KitchenController],
  providers: [KitchenService, KitchenProcessor],
  exports: [KitchenService],
})
export class KitchenModule {}
