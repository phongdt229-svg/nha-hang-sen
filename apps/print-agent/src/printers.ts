import type { PrinterState } from '@nhs/types';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Socket } from 'node:net';
import { CMD } from './escpos';

export interface PrinterStatus {
  state: PrinterState;
  error: string | null;
}

/** Lỗi khi in, kèm trạng thái để API biết lệnh cần nằm lại hàng đợi vì sao. */
export class PrintError extends Error {
  constructor(
    readonly state: 'OFFLINE' | 'PAPER_OUT' | 'ERROR',
    message: string,
  ) {
    super(message);
  }
}

export interface PrinterPort {
  readonly target: string;
  readonly name: string;
  readonly uri: string;
  status(): Promise<PrinterStatus>;
  /** preview: bản chữ của phiếu, dùng cho máy in console. */
  send(data: Buffer, preview: string): Promise<void>;
}

/**
 * Máy in mạng (cổng RAW 9100). Hỏi trạng thái giấy bằng DLE EOT 4; máy không trả lời thì
 * coi như sẵn sàng (nhiều máy tắt tính năng này), lỗi thật sẽ lộ ra khi gửi lệnh in.
 */
export class TcpPrinter implements PrinterPort {
  constructor(
    readonly target: string,
    readonly name: string,
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 3000,
  ) {}

  get uri() {
    return `tcp://${this.host}:${this.port}`;
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = new Socket();
      const fail = (e: Error) => {
        s.destroy();
        reject(new PrintError('OFFLINE', `Không kết nối được máy in ${this.uri}: ${e.message}`));
      };
      s.setTimeout(this.timeoutMs, () => fail(new Error('quá thời gian chờ')));
      s.once('error', fail);
      s.connect(this.port, this.host, () => {
        s.removeListener('error', fail);
        resolve(s);
      });
    });
  }

  async status(): Promise<PrinterStatus> {
    let s: Socket;
    try {
      s = await this.connect();
    } catch (e) {
      return { state: 'OFFLINE', error: (e as Error).message };
    }
    const reply = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 500);
      s.once('data', (d: Buffer) => {
        clearTimeout(timer);
        resolve(d[0] ?? null);
      });
      s.once('error', () => resolve(null));
      s.write(Buffer.from(CMD.paperStatus));
    });
    s.destroy();
    // Bit 5–6 của DLE EOT 4: cảm biến báo hết giấy.
    if (reply !== null && (reply & 0x60) === 0x60) return { state: 'PAPER_OUT', error: 'Máy in hết giấy' };
    return { state: 'ONLINE', error: null };
  }

  async send(data: Buffer): Promise<void> {
    const st = await this.status();
    if (st.state !== 'ONLINE') throw new PrintError(st.state as 'OFFLINE' | 'PAPER_OUT', st.error ?? st.state);
    const s = await this.connect();
    await new Promise<void>((resolve, reject) => {
      s.once('error', (e) => reject(new PrintError('OFFLINE', `Mất kết nối khi in: ${e.message}`)));
      s.end(data, () => resolve());
    });
    s.destroy();
  }
}

/** Ghi lệnh ESC/POS ra file (thử nghiệm không có máy in, hoặc máy in USB chia sẻ dạng file thiết bị). */
export class FilePrinter implements PrinterPort {
  constructor(
    readonly target: string,
    readonly name: string,
    private readonly path: string,
  ) {}

  get uri() {
    return `file:${this.path}`;
  }

  async status(): Promise<PrinterStatus> {
    return { state: 'ONLINE', error: null };
  }

  async send(data: Buffer) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, data);
  }
}

/** In bản xem trước ra màn hình — dùng khi demo. */
export class ConsolePrinter implements PrinterPort {
  constructor(
    readonly target: string,
    readonly name: string,
  ) {}

  readonly uri = 'console:';

  async status(): Promise<PrinterStatus> {
    return { state: 'ONLINE', error: null };
  }

  async send(_data: Buffer, preview: string) {
    console.log(`\n===== ${this.target} =====\n${preview}\n${'='.repeat(this.target.length + 12)}`);
  }
}
