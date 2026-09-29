import type { EncodeOptions } from './escpos';

export interface PrinterConfig {
  target: string;
  uri: string;
  /** Khổ giấy: 80mm → 48 ký tự, 58mm → 32 ký tự. */
  width: number;
}

export interface AgentConfig {
  apiUrl: string;
  printers: PrinterConfig[];
  encoding: EncodeOptions['encoding'];
  pollMs: number;
  statusEveryMs: number;
  tokenFile: string;
}

/**
 * PRINTERS="BEP_NONG=tcp://192.168.1.51:9100;QUAY_BAR=tcp://192.168.1.52:9100@58;RECEIPT=file:./out/receipt.bin"
 * Hậu tố "@58" chọn khổ giấy 58mm (mặc định 80mm).
 */
export function parsePrinters(spec: string): PrinterConfig[] {
  return spec
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) throw new Error(`Cấu hình máy in sai: "${entry}" (cần dạng MA=uri)`);
      const target = entry.slice(0, eq).trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,40}$/.test(target)) throw new Error(`Mã máy in không hợp lệ: ${target}`);
      let uri = entry.slice(eq + 1).trim();
      let width = 48;
      const m = /@(58|80)$/.exec(uri);
      if (m) {
        width = m[1] === '58' ? 32 : 48;
        uri = uri.slice(0, -m[0].length);
      }
      if (!/^(tcp:\/\/[^:/]+(:\d+)?|file:.+|console:?)$/.test(uri)) throw new Error(`Địa chỉ máy in không hỗ trợ: ${uri}`);
      return { target, uri, width };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    apiUrl: (env.API_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    printers: parsePrinters(env.PRINTERS ?? ''),
    encoding: env.PRINT_ENCODING === 'utf8' ? 'utf8' : 'ascii',
    pollMs: Number(env.POLL_MS ?? 1000),
    statusEveryMs: Number(env.STATUS_EVERY_MS ?? 5000),
    tokenFile: env.TOKEN_FILE ?? '.print-agent-token',
  };
}
