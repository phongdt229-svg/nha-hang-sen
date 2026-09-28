import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TEST_ENV } from './env';

Object.assign(process.env, TEST_ENV);

export interface Harness {
  app: INestApplication;
  prisma: import('@prisma/client').PrismaClient;
  url: string;
  call<T = any>(method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  login(username: string): Promise<string>;
  close(): Promise<void>;
}

export async function startApp(): Promise<Harness> {
  // Import sau khi đặt biến môi trường để module đọc đúng cấu hình test.
  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/main');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ rawBody: true }));
  const { PrismaService } = await import('../src/prisma/prisma.service');
  await app.listen(0);
  const url = await app.getUrl();

  const call: Harness['call'] = async (method, path, token, body, headers = {}) => {
    const raw = typeof body === 'string';
    const res = await fetch(url + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return { status: res.status, body: Buffer.from(await res.arrayBuffer()) as any };
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    app,
    prisma: app.get(PrismaService),
    url,
    call,
    login: async (username) => (await call('POST', '/auth/login', undefined, { username, password: 'sen123' })).body.token,
    close: () => app.close(),
  };
}

export const key = () => randomUUID();

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`Hết thời gian chờ, giá trị cuối: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Tạo phiên có order ở bàn trống tiếp theo; trả về id phiên, bàn và các món. */
export async function sessionWithOrder(h: Harness, token: string, codes: { code: string; qty: number }[]) {
  const tables = (await h.call('GET', '/tables', token)).body as { id: string; status: string; code: string }[];
  const table = tables.find((t) => t.status === 'AVAILABLE');
  if (!table) throw new Error('Hết bàn trống cho test');
  const session = (await h.call('POST', '/sessions', token, { tableId: table.id, guests: 2 })).body;
  const menu = (await h.call('GET', '/menu', token)).body.items as { id: string; code: string }[];
  const order = await h.call(
    'POST',
    `/sessions/${session.id}/orders`,
    token,
    { items: codes.map((c) => ({ menuItemId: menu.find((m) => m.code === c.code)!.id, qty: c.qty })) },
    { 'idempotency-key': key() },
  );
  return { session, table, order: order.body, menu };
}
