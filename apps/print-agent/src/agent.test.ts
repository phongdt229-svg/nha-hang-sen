import type { AgentJob, PrintDocument } from '@nhs/types';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, PrintAgent, type AgentApi } from './agent';
import { parsePrinters } from './config';
import { CMD, encode, foldVietnamese, pairLines, renderText } from './escpos';
import { TcpPrinter } from './printers';

const DOC: PrintDocument = {
  lines: [
    { kind: 'text', text: 'PHIẾU BẾP', align: 'center', bold: true },
    { kind: 'pair', left: '2 x Phở bò tái', right: '130.000đ' },
    { kind: 'rule' },
  ],
  cut: true,
  beep: true,
};

const includes = (buf: Buffer, seq: number[]) => buf.includes(Buffer.from(seq));

describe('ESC/POS', () => {
  it('bỏ dấu tiếng Việt cho máy in không có bảng mã', () => {
    expect(foldVietnamese('Phở bò tái – Đồng')).toBe('Pho bo tai ? Dong');
  });

  it('dòng hai cột căn đúng khổ giấy, tên dài xuống dòng không che số tiền', () => {
    expect(pairLines('Phở', '65.000đ', 20)).toEqual(['Phở' + ' '.repeat(10) + '65.000đ']);
    const lines = pairLines('Mì xào hải sản cay đặc biệt size lớn', '185.000đ', 32);
    expect(lines.length).toBe(2);
    expect(lines.every((l) => [...l].length <= 32)).toBe(true);
    expect(lines[1].endsWith('185.000đ')).toBe(true);
  });

  it('mã hóa có khởi tạo, căn giữa, in đậm, bíp và cắt giấy; chế độ ascii chỉ còn ký tự ASCII', () => {
    const buf = encode(DOC, { width: 48, encoding: 'ascii' });
    expect([...buf.subarray(0, 2)]).toEqual(CMD.init);
    expect(includes(buf, CMD.align('center'))).toBe(true);
    expect(includes(buf, CMD.bold(true))).toBe(true);
    expect(includes(buf, CMD.beep)).toBe(true);
    expect(includes(buf, CMD.cut)).toBe(true);
    expect(buf.toString('latin1')).toContain('PHIEU BEP');
    expect(buf.toString('latin1')).toContain('2 x Pho bo tai');
  });

  it('chế độ utf8 giữ nguyên tiếng Việt; bản xem trước khớp khổ giấy', () => {
    expect(encode(DOC, { width: 48, encoding: 'utf8' }).toString('utf8')).toContain('Phở bò tái');
    const text = renderText(DOC, 32).split('\n');
    expect(text[0].trim()).toBe('PHIẾU BẾP');
    expect(text[2]).toBe('-'.repeat(32));
  });
});

describe('cấu hình', () => {
  it('đọc danh sách máy in và khổ giấy', () => {
    expect(parsePrinters('bep_nong=tcp://192.168.1.51:9100; QUAY_BAR=tcp://10.0.0.2@58;RECEIPT=console:')).toEqual([
      { target: 'BEP_NONG', uri: 'tcp://192.168.1.51:9100', width: 48 },
      { target: 'QUAY_BAR', uri: 'tcp://10.0.0.2', width: 32 },
      { target: 'RECEIPT', uri: 'console:', width: 48 },
    ]);
    expect(() => parsePrinters('X=http://a')).toThrow();
  });
});

/** Máy in mạng giả: ghi nhận dữ liệu nhận được, trả lời DLE EOT 4 theo trạng thái giấy. */
function fakePrinter(opts: { paperOut: boolean }) {
  const received: Buffer[] = [];
  const server: Server = createServer((s) => {
    s.on('data', (d) => {
      if (d.length === 3 && d[0] === 0x10 && d[1] === 0x04 && d[2] === 0x04) s.write(Buffer.from([opts.paperOut ? 0x72 : 0x12]));
      else received.push(d);
    });
  });
  return new Promise<{ port: number; received: Buffer[]; opts: typeof opts; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, received, opts, close: () => server.close() })),
  );
}

function fakeApi(jobs: AgentJob[][]) {
  const calls: { path: string; body: any }[] = [];
  let offline = false;
  const api: AgentApi = {
    async post<T>(path: string, body: unknown) {
      if (offline) throw new Error('fetch failed');
      calls.push({ path, body });
      if (path === '/print/agent/poll') return { jobs: jobs.shift() ?? [] } as T;
      return {} as T;
    },
  };
  return { api, calls, setOffline: (v: boolean) => (offline = v) };
}

const job = (id: string, target = 'BEP_NONG'): AgentJob => ({ id, target, kind: 'KITCHEN_TICKET', title: `Phiếu ${id}`, document: DOC });

describe('PrintAgent', () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));

  it('in qua máy in mạng và báo đã in', async () => {
    const fp = await fakePrinter({ paperOut: false });
    closers.push(fp.close);
    const { api, calls } = fakeApi([[job('j1')]]);
    const agent = new PrintAgent(api, [{ port: new TcpPrinter('BEP_NONG', 'Bếp nóng', '127.0.0.1', fp.port), width: 48 }], { encoding: 'ascii', statusEveryMs: 0, log: () => {} });
    expect(await agent.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(fp.received).toString('latin1')).toContain('PHIEU BEP');
    expect(calls[0].body.printers[0]).toMatchObject({ target: 'BEP_NONG', state: 'ONLINE' });
    expect(calls.map((c) => c.path)).toContain('/print/jobs/j1/done');
  });

  it('hết giấy → báo PAPER_OUT, lệnh trả về hàng đợi; có giấy lại → in tiếp', async () => {
    const fp = await fakePrinter({ paperOut: true });
    closers.push(fp.close);
    const { api, calls } = fakeApi([[job('j2')], [job('j2')]]);
    const agent = new PrintAgent(api, [{ port: new TcpPrinter('BEP_NONG', 'Bếp nóng', '127.0.0.1', fp.port), width: 48 }], { encoding: 'ascii', statusEveryMs: 0, log: () => {} });
    await agent.tick();
    expect(calls[0].body.printers[0].state).toBe('PAPER_OUT');
    expect(calls.find((c) => c.path === '/print/jobs/j2/failed')?.body.state).toBe('PAPER_OUT');
    expect(fp.received).toHaveLength(0);

    fp.opts.paperOut = false;
    await agent.tick();
    expect(calls.map((c) => c.path)).toContain('/print/jobs/j2/done');
  });

  it('máy in tắt → OFFLINE', async () => {
    const fp = await fakePrinter({ paperOut: false });
    fp.close();
    const { api, calls } = fakeApi([[job('j3')]]);
    const agent = new PrintAgent(api, [{ port: new TcpPrinter('BEP_NONG', 'Bếp nóng', '127.0.0.1', fp.port, 300), width: 48 }], { encoding: 'ascii', statusEveryMs: 0, log: () => {} });
    await agent.tick();
    expect(calls.find((c) => c.path === '/print/jobs/j3/failed')?.body.state).toBe('OFFLINE');
  });

  it('mất mạng lúc báo kết quả → giữ lại và gửi bù, không in lần hai', async () => {
    const sent: string[] = [];
    const port = { target: 'RECEIPT', name: 'Quầy', uri: 'mem:', status: async () => ({ state: 'ONLINE' as const, error: null }), send: async () => void sent.push('x') };
    const fake = fakeApi([[job('j4', 'RECEIPT')]]);
    let failNext = false;
    const api: AgentApi = {
      post: async <T,>(path: string, body: unknown) => {
        if (failNext && path.endsWith('/done')) {
          failNext = false;
          throw new Error('fetch failed');
        }
        return fake.api.post<T>(path, body);
      },
    };
    const agent = new PrintAgent(api, [{ port, width: 48 }], { encoding: 'ascii', statusEveryMs: 0, log: () => {} });
    failNext = true;
    await expect(agent.tick()).rejects.toThrow('fetch failed');
    expect(sent).toHaveLength(1);
    await agent.tick();
    expect(fake.calls.filter((c) => c.path === '/print/jobs/j4/done')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('lỗi 4xx khi báo kết quả (lệnh đã bị hủy) → bỏ qua, không kẹt hàng đợi báo cáo', async () => {
    const port = { target: 'RECEIPT', name: 'Quầy', uri: 'mem:', status: async () => ({ state: 'ONLINE' as const, error: null }), send: async () => {} };
    const fake = fakeApi([[job('j5', 'RECEIPT')], []]);
    const api: AgentApi = {
      post: async <T,>(path: string, body: unknown) => {
        if (path.endsWith('/done')) throw new HttpError(404, 'Không tìm thấy lệnh in');
        return fake.api.post<T>(path, body);
      },
    };
    const agent = new PrintAgent(api, [{ port, width: 48 }], { encoding: 'ascii', statusEveryMs: 0, log: () => {} });
    await agent.tick();
    await agent.tick();
    expect(fake.calls.filter((c) => c.path === '/print/agent/poll')).toHaveLength(2);
  });
});
