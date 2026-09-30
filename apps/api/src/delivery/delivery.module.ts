import { Module } from '@nestjs/common';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { RobotGateway } from './robot-gateway';

@Module({
  controllers: [DeliveryController],
  providers: [RobotGateway, DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
