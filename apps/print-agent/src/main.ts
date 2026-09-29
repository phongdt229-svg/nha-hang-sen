import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createApi, HttpError, PrintAgent, type AgentPrinter } from './agent';
import { loadConfig, type PrinterConfig } from './config';
import { targetName } from './names';
import { ConsolePrinter, FilePrinter, TcpPrinter, type PrinterPort } from './printers';

const USAGE = `Print agent – Nhà hàng Sen

Biến môi trường:
  API_URL          địa chỉ API tại quán (mặc định http://localhost:3000)
  PRINTERS         danh sách máy in, ví dụ:
                   BEP_NONG=tcp://192.168.1.51:9100;QUAY_BAR=tcp://192.168.1.52:9100@58;RECEIPT=console:
  PAIRING_CODE     mã ghép 6 số tạo trên POS (mục Cảnh báo → "Ghép print agent"), chỉ cần lần đầu
  PRINT_ENCODING   ascii (bỏ dấu, mặc định) | utf8 (máy in hỗ trợ tiếng Việt UTF-8)
  TOKEN_FILE       nơi lưu token thiết bị (mặc định .print-agent-token)`;

function port(c: PrinterConfig): PrinterPort {
  const name = targetName(c.target);
  if (c.uri.startsWith('tcp://')) {
    const u = new URL(c.uri);
    return new TcpPrinter(c.target, name, u.hostname, Number(u.port || 9100));
  }
  if (c.uri.startsWith('file:')) return new FilePrinter(c.target, name, c.uri.slice(5));
  return new ConsolePrinter(c.target, name);
}

async function obtainToken(apiUrl: string, tokenFile: string): Promise<string> {
  if (process.env.PRINT_AGENT_TOKEN) return process.env.PRINT_AGENT_TOKEN;
  if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  const code = process.env.PAIRING_CODE;
  if (!code) throw new Error('Chưa ghép thiết bị: đặt PAIRING_CODE bằng mã 6 số tạo trên POS');
  const res = await fetch(`${apiUrl}/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: process.env.AGENT_NAME ?? `Print agent ${hostname()}` }),
  });
  const body = (await res.json()) as { token?: string; message?: string };
  if (!res.ok || !body.token) throw new Error(`Ghép thiết bị thất bại: ${body.message ?? res.status}`);
  writeFileSync(tokenFile, body.token, { mode: 0o600 });
  console.log(`Đã ghép thiết bị, token lưu ở ${tokenFile}`);
  return body.token;
}

async function main() {
  const config = loadConfig();
  if (config.printers.length === 0) {
    console.log(USAGE);
    process.exit(1);
  }
  const token = await obtainToken(config.apiUrl, config.tokenFile);
  const printers: AgentPrinter[] = config.printers.map((c) => ({ port: port(c), width: c.width }));
  const agent = new PrintAgent(createApi(config.apiUrl, () => token), printers, { encoding: config.encoding, statusEveryMs: config.statusEveryMs });
  console.log(`Print agent chạy với ${printers.map((p) => `${p.port.target}=${p.port.uri}`).join(', ')} → ${config.apiUrl}`);

  let stopped = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopped) {
    try {
      await agent.tick();
      if (failures > 0) console.log('Đã kết nối lại API');
      failures = 0;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        console.error('Token thiết bị không hợp lệ hoặc đã bị thu hồi. Xóa file token và ghép lại.');
        process.exit(2);
      }
      failures++;
      if (failures === 1 || failures % 30 === 0) console.warn(`Không gọi được API (${failures} lần): ${e instanceof Error ? e.message : e}`);
    }
    // Mất kết nối API thì giãn nhịp dần, tối đa 10 giây.
    await new Promise((r) => setTimeout(r, failures === 0 ? config.pollMs : Math.min(10_000, config.pollMs * 2 ** Math.min(failures, 4))));
  }
  console.log('Đã dừng print agent');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
