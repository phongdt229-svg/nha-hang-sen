import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { TEST_ENV } from './env';

/** Chuẩn bị database test riêng: tạo nếu chưa có, chạy migration, xóa sạch dữ liệu rồi nạp dữ liệu mẫu. */
export default async function globalSetup() {
  const url = new URL(TEST_ENV.DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!/_test$/.test(dbName)) throw new Error(`Từ chối chạy test trên database không phải *_test: ${dbName}`);

  const admin = new PrismaClient({ datasourceUrl: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  const exists = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  if (exists.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  await admin.$disconnect();

  const env = { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL };
  const cwd = `${__dirname}/..`;
  execSync('npx prisma migrate deploy', { cwd, env, stdio: 'ignore' });

  const db = new PrismaClient({ datasourceUrl: TEST_ENV.DATABASE_URL });
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await db.$disconnect();
  execSync('npx ts-node -P tsconfig.test.json prisma/seed.ts', { cwd, env, stdio: 'ignore' });

  // 60 bàn (hơn quy mô 40 bàn của mục 17.2) để các file test, kể cả test giao món bằng robot, không tranh bàn trống của nhau.
  const seeded = new PrismaClient({ datasourceUrl: TEST_ENV.DATABASE_URL });
  for (let i = 13; i <= 60; i++) {
    await seeded.table.create({ data: { code: `T${i}`, seats: 4, zone: 'Test' } });
  }
  await seeded.$disconnect();
}
