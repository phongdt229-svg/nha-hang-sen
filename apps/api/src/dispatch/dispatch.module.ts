import { Module } from '@nestjs/common';
import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';
import { RobotRegistry } from './robot.registry';

@Module({ controllers: [DispatchController], providers: [RobotRegistry, DispatchService] })
export class DispatchModule {}
