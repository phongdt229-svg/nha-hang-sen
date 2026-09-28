import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { Notifier } from './notifier';

@Global()
@Module({ providers: [AuditService, Notifier], exports: [AuditService, Notifier] })
export class CommonModule {}
