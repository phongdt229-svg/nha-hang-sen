import { Global, Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { OutboxPublisher } from './outbox.publisher';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService, OutboxPublisher, RealtimeGateway],
  exports: [EventsService, OutboxPublisher, RealtimeGateway],
})
export class EventsModule {}
