import type { AgentJob, AgentPollRequest } from '@nhs/types';
import { encode, renderText, type EncodeOptions } from './escpos';
import { PrintError, type PrinterPort, type PrinterStatus } from './printers';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentApi {
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createApi(apiUrl: string, token: () => string): AgentApi {
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      const res = await fetch(apiUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text || res.statusText);
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

export interface AgentPrinter {
  port: PrinterPort;
  width: number;
}

type Report = { id: string; path: string; body: unknown };

/**
 * Một vòng làm việc của agent: kiểm tra máy in → gửi nhịp kèm trạng thái → in các lệnh được giao →
 * báo kết quả. Báo kết quả thất bại vì mất mạng thì giữ lại gửi sau, để API không giao in lại lần nữa.
 */
export class PrintAgent {
  private readonly states = new Map<string, PrinterStatus>();
  private lastCheck = 0;
  private readonly reports: Report[] = [];

  constructor(
    private readonly api: AgentApi,
    private readonly printers: AgentPrinter[],
    private readonly opts: { encoding: EncodeOptions['encoding']; statusEveryMs: number; log?: (msg: string) => void },
  ) {}

  private log(msg: string) {
    (this.opts.log ?? console.log)(msg);
  }

  state(target: string): PrinterStatus {
    return this.states.get(target) ?? { state: 'UNKNOWN', error: null };
  }

  async checkPrinters(force = false) {
    const now = Date.now();
    if (!force && now - this.lastCheck < this.opts.statusEveryMs) return;
    this.lastCheck = now;
    await Promise.all(
      this.printers.map(async (p) => {
        const s = await p.port.status().catch((e: Error) => ({ state: 'ERROR' as const, error: e.message }));
        const before = this.states.get(p.port.target);
        if (before?.state !== s.state) this.log(`[${p.port.target}] ${s.state}${s.error ? ` – ${s.error}` : ''}`);
        this.states.set(p.port.target, s);
      }),
    );
  }

  private async flushReports() {
    while (this.reports.length > 0) {
      const r = this.reports[0];
      try {
        await this.api.post(r.path, r.body);
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) this.log(`Bỏ báo cáo ${r.path}: ${e.message}`);
        else throw e;
      }
      this.reports.shift();
    }
  }

  private async report(id: string, path: string, body: unknown) {
    this.reports.push({ id, path, body });
    await this.flushReports();
  }

  /** Một vòng; trả về số lệnh đã in. */
  async tick(): Promise<number> {
    await this.flushReports();
    await this.checkPrinters();
    const body: AgentPollRequest = {
      printers: this.printers.map((p) => ({ target: p.port.target, name: p.port.name, ...this.state(p.port.target) })),
    };
    const { jobs } = await this.api.post<{ jobs: AgentJob[] }>('/print/agent/poll', body);
    let printed = 0;
    for (const job of jobs) if (await this.print(job)) printed++;
    return printed;
  }

  private async print(job: AgentJob): Promise<boolean> {
    const p = this.printers.find((x) => x.port.target === job.target);
    if (!p) {
      await this.report(job.id, `/print/jobs/${job.id}/failed`, { state: 'ERROR', error: `Agent không cấu hình máy in ${job.target}` });
      return false;
    }
    // Máy vừa lỗi ở lệnh trước trong cùng vòng: trả lệnh về hàng đợi ngay, không chờ hết thời gian kết nối.
    const known = this.state(job.target);
    if (known.state === 'OFFLINE' || known.state === 'PAPER_OUT') {
      await this.report(job.id, `/print/jobs/${job.id}/failed`, { state: known.state, error: known.error ?? known.state });
      return false;
    }
    try {
      await p.port.send(encode(job.document, { width: p.width, encoding: this.opts.encoding }), renderText(job.document, p.width));
    } catch (e) {
      const state = e instanceof PrintError ? e.state : 'ERROR';
      const error = e instanceof Error ? e.message : String(e);
      this.states.set(job.target, { state, error });
      this.log(`[${job.target}] In lỗi "${job.title}": ${error}`);
      await this.report(job.id, `/print/jobs/${job.id}/failed`, { state, error });
      return false;
    }
    this.states.set(job.target, { state: 'ONLINE', error: null });
    this.log(`[${job.target}] Đã in: ${job.title}`);
    await this.report(job.id, `/print/jobs/${job.id}/done`, {});
    return true;
  }
}
