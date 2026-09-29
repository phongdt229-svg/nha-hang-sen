// Kiểm thử tải giờ cao điểm (mục 15, 17.2): 40 bàn cùng phục vụ, KDS nhận phiếu ở 3 trạm.
// Chạy: xem infra/k6/README.md. Mục tiêu: p95 API < 300 ms, p95 order → KDS ACK < 1 giây,
// không lỗi, gửi lại cùng Idempotency-Key không tạo order trùng.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/experimental/websockets';
import { setTimeout } from 'k6/timers';
import exec from 'k6/execution';

const API = __ENV.API_URL || 'http://localhost:3000';
const TABLES = Number(__ENV.TABLES || 40);
const DURATION = __ENV.DURATION || '10m';
/** Giây giữa hai lần gọi món của một bàn. 300 order/giờ với 40 bàn ≈ 480 giây; mặc định dồn nhanh để thử tải nặng hơn. */
const THINK = Number(__ENV.THINK || 20);
const ORDERS_PER_SESSION = Number(__ENV.ORDERS_PER_SESSION || 3);
const PASSWORD = __ENV.PASSWORD || 'sen123';
const STATIONS = ['BEP_NONG', 'BEP_LANH', 'QUAY_BAR'];
/** Bàn đang ăn dở lúc hết giờ được chạy tiếp tối đa chừng này để thanh toán xong. */
const GRACE = '3m';

const ordersCreated = new Counter('orders_created');
const duplicateOrders = new Counter('orders_duplicated');
const acks = new Counter('kds_acks');
const orderLatency = new Trend('order_confirm_ms', true);
const kdsAckP95 = new Trend('kds_ack_p95_seconds');

export const options = {
  scenarios: {
    // gracefulStop: bàn đang ăn dở được thanh toán xong, không để lại phiên mở sau khi chạy.
    tables: { executor: 'constant-vus', vus: TABLES, duration: DURATION, gracefulStop: GRACE, exec: 'table' },
    // Mỗi trạm một màn hình bếp giữ kết nối WebSocket suốt buổi, như KDS thật.
    kds: { executor: 'per-vu-iterations', vus: STATIONS.length, iterations: 1, maxDuration: `${Math.round((durationMs(DURATION) + durationMs(GRACE)) / 1000) + 30}s`, exec: 'kds' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:api}': ['p(95)<300'],
    order_confirm_ms: ['p(95)<300'],
    orders_duplicated: ['count==0'],
    kds_ack_p95_seconds: ['max<1'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

/** Khóa idempotency không cần thư viện ngoài (tại quán có thể không có Internet). */
const uuidv4 = () => `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const json = (token, extra = {}) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, tags: { kind: 'api' } });

function login(username) {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ username, password: PASSWORD }), { headers: { 'content-type': 'application/json' } });
  if (r.status !== 201) fail(`Đăng nhập ${username} thất bại: ${r.status}`);
  return r.json('token');
}

export function setup() {
  const manager = login('quanly');
  const kitchen = login('bep');
  // Chỉ dùng bàn đang trống để không đụng phiên thật còn dở.
  const tables = http.get(`${API}/tables`, json(manager)).json().filter((t) => t.status === 'AVAILABLE').sort((a, b) => a.code.localeCompare(b.code));
  if (tables.length < TABLES) fail(`Cần ${TABLES} bàn trống, hiện có ${tables.length}. Nạp dữ liệu với SEED_TABLES=${TABLES + 5}.`);
  const menu = http.get(`${API}/menu`, json(manager)).json().items.filter((m) => m.available !== false);
  return { ackBaseline: ackBuckets(), manager, kitchen, tables: tables.slice(0, TABLES).map((t) => t.id), menu: menu.map((m) => m.id) };
}

function pick(list, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ menuItemId: list[Math.floor(Math.random() * list.length)], qty: 1 + Math.floor(Math.random() * 2) });
  return out;
}

/** Bàn mà VU này đang phục vụ (biến cấp module là riêng của từng VU). */
let myTable = null;

/** Một bàn: mở phiên → gọi món vài lần → khóa bill → thu tiền → dọn bàn. */
export function table(data) {
  const token = data.manager;
  // Mở phiên ở bàn của VU; lần đầu (hoặc bị VU khác chiếm) thì giành một bàn trống — server từ chối
  // mở phiên ở bàn đã có khách, nên hai VU không bao giờ dùng chung bàn. 409 ở bước này là bình thường.
  const open = (tableId) =>
    http.post(`${API}/sessions`, JSON.stringify({ tableId, guests: 2 + Math.floor(Math.random() * 4) }), {
      ...json(token),
      responseCallback: http.expectedStatuses(201, 409),
    });
  let r = myTable ? open(myTable) : null;
  if (!r || r.status !== 201) {
    myTable = null;
    const n = data.tables.length;
    const start = (exec.vu.idInTest - 1) % n;
    for (let k = 0; k < n && !myTable; k++) {
      const id = data.tables[(start + k) % n];
      r = open(id);
      if (r.status === 201) myTable = id;
    }
    if (!myTable) {
      sleep(2);
      return;
    }
  }
  const tableId = myTable;
  const sessionId = r.json('id');

  for (let i = 0; i < ORDERS_PER_SESSION; i++) {
    sleep(THINK * (0.5 + Math.random()));
    const key = uuidv4();
    const body = JSON.stringify({ items: pick(data.menu, 1 + Math.floor(Math.random() * 3)) });
    r = http.post(`${API}/sessions/${sessionId}/orders`, body, json(token, { 'idempotency-key': key }));
    orderLatency.add(r.timings.duration);
    if (check(r, { 'order 201': (x) => x.status === 201 })) ordersCreated.add(1);
    // 1/10 lần: mạng gửi lại cùng khóa → phải trả về đúng order cũ.
    if (Math.random() < 0.1 && r.status === 201) {
      const again = http.post(`${API}/sessions/${sessionId}/orders`, body, json(token, { 'idempotency-key': key }));
      if (again.status < 300 && again.json('id') !== r.json('id')) duplicateOrders.add(1);
      check(again, { 'gửi lại cùng khóa → cùng order': (x) => x.status < 300 && x.json('id') === r.json('id') });
    }
  }

  sleep(THINK * 0.5);
  const bill = http.get(`${API}/sessions/${sessionId}/bill`, json(token)).json();
  r = http.post(`${API}/bills/${bill.id}/lock`, JSON.stringify({ version: bill.version }), json(token));
  check(r, { 'khóa bill': (x) => x.status === 201 });
  r = http.post(`${API}/bills/${bill.id}/payments`, JSON.stringify({ method: 'QR' }), json(token, { 'idempotency-key': uuidv4() }));
  check(r, { 'tạo thanh toán QR': (x) => x.status === 201 });
  if (r.status === 201) {
    r = http.post(`${API}/payments/${r.json('payment.id')}/confirm`, '{}', json(token));
    check(r, { 'xác nhận tiền về': (x) => x.status === 201 });
  }
  r = http.post(`${API}/tables/${tableId}/cleaned`, '{}', json(token));
  check(r, { 'dọn bàn': (x) => x.status === 201 });
}

/** "10m", "90s", "1h" → mili giây. */
function durationMs(d) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) return 600_000;
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
}

/**
 * Màn hình bếp giả lập nói giao thức socket.io (Engine.IO v4) qua WebSocket như KDS thật:
 * nhận sự kiện kitchen.sent của trạm và ACK ngay.
 */
export function kds(data) {
  // Số lượt trong scenario là 0, 1, 2 — mỗi trạm đúng một KDS (__VU đánh số chung mọi scenario nên có thể trùng trạm).
  const station = STATIONS[exec.scenario.iterationInTest % STATIONS.length];
  const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
  ws.onmessage = (e) => {
    const msg = String(e.data);
    if (msg === '2') return ws.send('3'); // ping → pong
    if (msg.startsWith('0')) return ws.send('40' + JSON.stringify({ token: data.kitchen, station })); // mở → kết nối namespace kèm token
    if (!msg.startsWith('42')) return;
    const [name, ev] = JSON.parse(msg.slice(2));
    if (name !== 'event' || ev.type !== 'kitchen.sent') return;
    const r = http.post(`${API}/kitchen/tickets/${ev.data.ticket.id}/ack`, '{}', json(data.kitchen));
    if (check(r, { 'KDS ACK': (x) => x.status === 201 })) acks.add(1);
  };
  ws.onerror = (e) => console.error(`KDS ${station} lỗi WebSocket: ${e.error}`);
  // Ở lại tới khi các bàn chạy nốt phần gracefulStop, nếu không phiếu cuối sẽ không ai nhận → FALLBACK.
  setTimeout(() => ws.close(), durationMs(DURATION) + durationMs(GRACE) + 10_000);
}

function ackBuckets() {
  const text = http.get(`${API}/metrics`, { headers: __ENV.METRICS_TOKEN ? { authorization: `Bearer ${__ENV.METRICS_TOKEN}` } : {} }).body || '';
  const buckets = {};
  for (const line of text.split('\n')) {
    const m = /^nhs_kds_ack_latency_seconds_bucket\{.*via="kds".*le="([^"]+)"\} (\d+)/.exec(line);
    if (m) buckets[m[1]] = (buckets[m[1]] || 0) + Number(m[2]);
  }
  return buckets;
}

/** Đọc histogram order → KDS ACK từ /metrics của API (trừ số liệu có từ trước lần chạy) để so với p95 < 1 giây. */
export function teardown(data) {
  const now = ackBuckets();
  const diff = Object.keys(now).map((le) => ({ le: le === '+Inf' ? Infinity : Number(le), n: now[le] - ((data.ackBaseline || {})[le] || 0) }));
  diff.sort((a, b) => a.le - b.le);
  const total = diff.length ? diff[diff.length - 1].n : 0;
  const p95 = diff.find((b) => b.n >= total * 0.95)?.le;
  const p50 = diff.find((b) => b.n >= total * 0.5)?.le;
  console.log(`order → KDS ACK: ${total} phiếu, p50 ≤ ${p50} giây, p95 ≤ ${p95} giây (theo bucket của API)`);
  if (total > 0) kdsAckP95.add(p95 === Infinity ? 999 : p95);
}
