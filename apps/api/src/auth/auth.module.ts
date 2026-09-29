import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { UsersController } from './users.controller';

@Global()
@Module({
  imports: [JwtModule.register({ global: true, secret: process.env.JWT_SECRET ?? 'dev-secret' })],
  controllers: [AuthController, UsersController],
  providers: [AuthGuard, { provide: APP_GUARD, useExisting: AuthGuard }],
  exports: [AuthGuard],
})
export class AuthModule {}
