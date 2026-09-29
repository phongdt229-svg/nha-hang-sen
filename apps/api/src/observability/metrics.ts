/**
 * Bộ đo tối giản theo định dạng văn bản của Prometheus (mục 13.7, Sprint 7): đủ cho counter,
 * gauge, histogram có nhãn, không cần thêm thư viện. Prometheus/Grafana đọc qua GET /metrics.
 */
type Labels = Record<string, string | number>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
const fmt = (name: string, labels: string, value: number) => `${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`;

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => fmt(this.name, k, v))];
  }
}

export class Gauge implements Metric {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(value: number, labels: Labels = {}) {
    this.values.set(key(labels), value);
  }
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  /** Thay toàn bộ giá trị (dùng khi đo lại từ DB mỗi lần Prometheus đọc). */
  reset() {
    this.values = new Map();
  }
  render() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, ...[...this.values].map(([k, v]) => fmt(this.name, k, v))];
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(value: number, labels: Labels = {}) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) this.series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) s.counts[i]++;
    s.sum += value;
    s.count++;
  }
  /** Phân vị ước lượng từ bucket (cho kiểm thử và cảnh báo nội bộ). */
  quantile(q: number, labels: Labels = {}): number | null {
    const s = this.series.get(key(labels));
    if (!s || s.count === 0) return null;
    const rank = q * s.count;
    for (let i = 0; i < this.buckets.length; i++) if (s.counts[i] >= rank) return this.buckets[i];
    return Infinity;
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? ',' : '';
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`));
      out.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`, fmt(`${this.name}_sum`, k, s.sum), fmt(`${this.name}_count`, k, s.count));
    }
    return out;
  }
}

class Registry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: (() => Promise<void>)[] = [];

  add<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }

  /** Hàm đo lại số liệu tức thời (tồn hàng đợi, số lệnh in chờ…) ngay trước khi xuất. */
  onCollect(fn: () => Promise<void>) {
    this.collectors.push(fn);
  }

  async render(): Promise<string> {
    await Promise.all(this.collectors.map((c) => c().catch(() => undefined)));
    return this.metrics.flatMap((m) => m.render()).join('\n') + '\n';
  }
}

export const registry = new Registry();

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const metrics = {
  httpDuration: registry.add(new Histogram('nhs_http_request_duration_seconds', 'Thời gian xử lý request API', SECONDS)),
  httpErrors: registry.add(new Counter('nhs_http_errors_total', 'Số request lỗi 5xx')),
  ordersConfirmed: registry.add(new Counter('nhs_orders_confirmed_total', 'Số order đã xác nhận')),
  kdsAckLatency: registry.add(new Histogram('nhs_kds_ack_latency_seconds', 'Từ lúc gửi phiếu tới KDS đến khi KDS ACK (mục 17.2: p95 < 1 giây)', [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 30])),
  kdsFallbacks: registry.add(new Counter('nhs_kds_fallback_total', 'Số phiếu bếp hết lượt gửi lại (FALLBACK)')),
  paymentsSucceeded: registry.add(new Counter('nhs_payments_succeeded_total', 'Số thanh toán thành công')),
  wsClients: registry.add(new Gauge('nhs_ws_clients', 'Số kết nối WebSocket đang mở')),
  outboxBacklog: registry.add(new Gauge('nhs_outbox_backlog', 'Số sự kiện chưa phát')),
  outboxOldestSeconds: registry.add(new Gauge('nhs_outbox_oldest_seconds', 'Tuổi sự kiện chưa phát lâu nhất')),
  queueJobs: registry.add(new Gauge('nhs_queue_jobs', 'Số job BullMQ theo hàng đợi và trạng thái')),
  printPending: registry.add(new Gauge('nhs_print_jobs_pending', 'Lệnh in đang chờ theo máy in')),
  printerUp: registry.add(new Gauge('nhs_printer_up', '1 nếu máy in sẵn sàng và agent còn gửi nhịp')),
  einvoiceUnissued: registry.add(new Gauge('nhs_einvoice_unissued', 'Hóa đơn điện tử chưa phát hành theo trạng thái')),
  tablesByStatus: registry.add(new Gauge('nhs_tables', 'Số bàn theo trạng thái')),
  robotsByState: registry.add(new Gauge('nhs_robots', 'Số robot theo trạng thái')),
  up: registry.add(new Gauge('nhs_dependency_up', '1 nếu phụ thuộc (postgres, redis) phản hồi')),
  processStart: registry.add(new Gauge('nhs_process_start_time_seconds', 'Thời điểm tiến trình API khởi động')),
  memory: registry.add(new Gauge('nhs_process_resident_memory_bytes', 'Bộ nhớ RSS của tiến trình API')),
};
