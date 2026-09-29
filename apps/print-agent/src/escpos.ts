import type { PrintDocument, PrintLine } from '@nhs/types';

/**
 * Mã hóa tài liệu in thành lệnh ESC/POS (chuẩn Epson, dùng được cho Xprinter, Rongta, Sunmi…).
 * Nhiều máy in nhiệt giá rẻ không có bảng mã tiếng Việt: mặc định bỏ dấu ('ascii');
 * máy in hỗ trợ UTF-8 thì đặt encoding 'utf8'.
 */
export interface EncodeOptions {
  /** Số ký tự mỗi dòng ở cỡ chữ thường: 48 cho giấy 80mm, 32 cho 58mm. */
  width: number;
  encoding: 'ascii' | 'utf8';
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const CMD = {
  init: [ESC, 0x40],
  align: (a: 'left' | 'center' | 'right') => [ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2],
  bold: (on: boolean) => [ESC, 0x45, on ? 1 : 0],
  /** GS ! n: 0x11 = gấp đôi rộng và cao. */
  size: (s: 1 | 2) => [GS, 0x21, s === 2 ? 0x11 : 0x00],
  feed: (n: number) => [ESC, 0x64, Math.max(0, Math.min(255, n))],
  /** Cắt giấy một phần sau khi đẩy giấy thêm (GS V 66 n). */
  cut: [GS, 0x56, 0x42, 0x03],
  /** Bíp 3 lần (ESC B n t, có trên đa số máy in bếp). */
  beep: [ESC, 0x42, 0x03, 0x02],
  /** Hỏi trạng thái cuộn giấy (DLE EOT 4). */
  paperStatus: [0x10, 0x04, 0x04],
};

/** Bỏ dấu tiếng Việt cho máy in không có bảng mã: "Phở bò tái" → "Pho bo tai". */
export function foldVietnamese(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** Độ dài hiển thị (ký tự), không tính dấu tổ hợp. */
const visible = (s: string) => [...s.normalize('NFC')].length;

function fit(s: string, n: number): string {
  const chars = [...s.normalize('NFC')];
  return chars.length <= n ? s : chars.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** Dòng hai cột: tên bên trái, số tiền bên phải; tên dài thì xuống dòng để không che số tiền. */
export function pairLines(left: string, right: string, width: number): string[] {
  const room = width - visible(right) - 1;
  if (room < 4) return [fit(left, width), right.padStart(width)];
  const out: string[] = [];
  let rest = [...left.normalize('NFC')];
  while (rest.length > room) {
    const chunk = rest.slice(0, room);
    const cut = chunk.lastIndexOf(' ');
    const take = cut > room / 2 ? cut : room;
    out.push(rest.slice(0, take).join('').trimEnd());
    rest = rest.slice(take);
    while (rest[0] === ' ') rest.shift();
  }
  const last = rest.join('');
  out.push(last + ' '.repeat(width - visible(last) - visible(right)) + right);
  return out;
}

/** Bản xem trước dạng chữ (in ra console, lưu file, và dùng trong kiểm thử). */
export function renderText(doc: PrintDocument, width: number): string {
  const out: string[] = [];
  for (const l of doc.lines) {
    switch (l.kind) {
      case 'text': {
        const w = l.size === 2 ? Math.floor(width / 2) : width;
        const t = fit(l.text, w);
        const pad = w - visible(t);
        const left = l.align === 'center' ? Math.floor(pad / 2) : l.align === 'right' ? pad : 0;
        out.push((' '.repeat(left) + t).trimEnd());
        break;
      }
      case 'pair':
        out.push(...pairLines(l.left, l.right, width));
        break;
      case 'rule':
        out.push('-'.repeat(width));
        break;
      case 'feed':
        for (let i = 0; i < l.lines; i++) out.push('');
        break;
      case 'qr':
        out.push(`[QR] ${l.data}`);
        break;
    }
  }
  return out.join('\n');
}

function qr(data: Uint8Array): number[] {
  const len = data.length + 3;
  return [
    ...[GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00], // model 2
    ...[GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 0x06], // cỡ ô 6
    ...[GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31], // sửa lỗi mức M
    ...[GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...data], // nạp dữ liệu
    ...[GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30], // in
  ];
}

export function encode(doc: PrintDocument, opts: EncodeOptions): Buffer {
  const text = (s: string) => [...Buffer.from(opts.encoding === 'ascii' ? foldVietnamese(s) : s, opts.encoding === 'ascii' ? 'latin1' : 'utf8')];
  const bytes: number[] = [...CMD.init];
  const line = (l: PrintLine) => {
    switch (l.kind) {
      case 'text': {
        const w = l.size === 2 ? Math.floor(opts.width / 2) : opts.width;
        bytes.push(...CMD.align(l.align ?? 'left'), ...CMD.bold(!!l.bold), ...CMD.size(l.size ?? 1), ...text(fit(l.text, w)), LF);
        bytes.push(...CMD.size(1), ...CMD.bold(false), ...CMD.align('left'));
        break;
      }
      case 'pair':
        bytes.push(...CMD.bold(!!l.bold));
        for (const s of pairLines(l.left, l.right, opts.width)) bytes.push(...text(s), LF);
        bytes.push(...CMD.bold(false));
        break;
      case 'rule':
        bytes.push(...text('-'.repeat(opts.width)), LF);
        break;
      case 'feed':
        bytes.push(...CMD.feed(l.lines));
        break;
      case 'qr':
        bytes.push(...CMD.align('center'), ...qr(Buffer.from(l.data, 'utf8')), LF, ...CMD.align('left'));
        break;
    }
  };
  if (doc.beep) bytes.push(...CMD.beep);
  for (const l of doc.lines) line(l);
  if (doc.cut) bytes.push(...CMD.feed(3), ...CMD.cut);
  return Buffer.from(bytes);
}
