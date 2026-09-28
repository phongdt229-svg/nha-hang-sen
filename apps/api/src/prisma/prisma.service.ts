import { Global, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit() {
    await this.$connect();
  }

  /** Ngắt kết nối ở bước cuối, sau khi các tiến trình nền đã dừng ở onModuleDestroy. */
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
