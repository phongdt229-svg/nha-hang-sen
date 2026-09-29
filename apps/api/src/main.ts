import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ErrorsFilter } from './common/errors.filter';
import { httpMetrics } from './observability/http-metrics';

export function configureApp(app: INestApplication) {
  app.use(httpMetrics);
  app.enableCors({ origin: true });
  app.useGlobalFilters(new ErrorsFilter());
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  // Không chạy môi trường thật với khóa ký token mặc định: ai biết khóa là giả được token quản lý.
  const secret = process.env.JWT_SECRET ?? '';
  if (process.env.NODE_ENV === 'production' && (secret.length < 32 || ['dev-secret', 'doi-chuoi-bi-mat-nay'].includes(secret))) {
    throw new Error('JWT_SECRET chưa đặt hoặc quá ngắn (cần ≥ 32 ký tự ngẫu nhiên). Xem docs/van-hanh/trien-khai-tai-quan.md');
  }
  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true }));
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Nhà hàng Sen API').setVersion('0.1').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, doc);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

if (require.main === module) void bootstrap();
