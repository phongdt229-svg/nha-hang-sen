import type { LinePort } from './protocol';

/**
 * Cổng serial thật: cáp USB (CH340 trên mCore) hoặc module Bluetooth đã ghép đôi (hiện thành COMx
 * trên Windows, /dev/rfcommX hoặc /dev/ttyUSBx trên Linux). Nạp `serialport` lúc chạy để chế độ ảo
 * không cần thư viện native.
 */
export async function openSerial(path: string, baudRate = 115200): Promise<LinePort> {
  const { SerialPort, ReadlineParser } = await import('serialport');
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  const handlers: ((line: string) => void)[] = [];
  parser.on('data', (line: string) => handlers.forEach((h) => h(line.replace(/\r$/, ''))));
  return {
    write: (line) => void port.write(line),
    onLine: (h) => void handlers.push(h),
    close: () => new Promise<void>((resolve) => (port.isOpen ? port.close(() => resolve()) : resolve())),
  };
}
