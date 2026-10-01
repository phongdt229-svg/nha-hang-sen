import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { EventsModule } from '../events/events.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [EventsModule, CommonModule],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
export class InventoryModule {}
