import type { BillDto, DeliveryTaskDto, OrderDto, SessionDto, TableDto } from '@nhs/types';
import { Button, DELIVERY_PROBLEM_LABEL, DELIVERY_STATUS_LABEL, formatVnd, storage, TABLE_STATUS_LABEL, type GuideTarget } from '@nhs/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { usePos } from './context';

/**
 * Chạy thử toàn bộ luồng (HD-05): chọn một bàn, bảng bước tự đánh dấu theo dữ liệu thật
 * (mở bàn → gọi món → bếp → robot → thanh toán → dọn bàn) và chỉ chỗ cần bấm tiếp theo.
 */

export interface WalkState {
  tableId: string;
  sessionId: string | null;
  startedAt: string;
}

export type WalkTab = 'tables' | 'robots' | 'alerts';

const KEY = 'nhs.pos.walkthrough';

export function loadWalk(): WalkState | null {
  try {
    return JSON.parse(storage.get(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function saveWalk(w: WalkState | null) {
  storage.set(KEY, w ? JSON.stringify(w) : null);
}

type Where = WalkTab | 'kds' | 'tablet';

const WHERE_LABEL: Record<Where, string> = {
  tables: 'Sơ đồ bàn',
  robots: 'Robot',
  alerts: 'Cảnh báo',
  kds: 'Màn hình bếp',
  tablet: 'Tablet',
};

export interface WalkStep {
  key: string;
  title: string;
  where: Where;
  how: string;
  done: boolean;
  skipped: boolean;
  detail?: string;
}

const ACKED = ['KDS_ACK', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'];
const COOKED = ['READY', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'];
const LOADED = ['GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'DELIVERED', 'RETURNING', 'COMPLETED'];
const HANDED = ['DELIVERED', 'RETURNING', 'COMPLETED'];
const CONFIRMED_BY = { CUSTOMER: 'khách bấm "Đã nhận món"', STAFF: 'nhân viên xác nhận', ROBOT_BUTTON: 'khách bấm nút trên robot' };

/** Tính trạng thái từng bước từ dữ liệu hiện có. Bước sau đã xong thì bước trước coi như xong (hoặc bỏ qua). */
export function walkSteps(d: {
  table: TableDto | undefined;
  session: SessionDto | undefined;
  orders: OrderDto[];
  bills: BillDto[];
  tasks: DeliveryTaskDto[];
}): WalkStep[] {
  const code = d.table?.code ?? '…';
  const items = d.orders.flatMap((o) => o.items).filter((i) => i.status !== 'CANCELLED');
  const task = d.tasks[0];
  const staff = items.some((i) => i.status === 'DELIVERED') && (!task || task.status === 'MANUAL_TAKEOVER');
  const closed = d.session?.status === 'CLOSED';
  const bills = d.bills.filter((b) => b.status !== 'SPLIT');
  const paid = closed || (bills.length > 0 && bills.every((b) => b.status === 'PAID' || b.status === 'CLOSED'));
  const count = (st: string[]) => items.filter((i) => st.includes(i.status)).reduce((a, i) => a + i.qty, 0);
  const total = items.reduce((a, i) => a + i.qty, 0);

  const raw: Omit<WalkStep, 'skipped'>[] = [
    {
      key: 'open',
      title: 'Mở bàn',
      where: 'tables',
      how: `Bấm bàn ${code} → nhập số khách → Mở bàn.`,
      done: !!d.session,
      detail: d.session && `Phiên ${d.session.code} · ${d.session.guests} khách`,
    },
    {
      key: 'order',
      title: 'Gọi món',
      where: 'tablet',
      how: `Tablet của bàn: chọn món → Giỏ hàng → Xác nhận gọi món. Hoặc POS: bấm bàn ${code} → Gọi món hộ.`,
      done: total > 0,
      detail: total > 0 ? items.map((i) => `${i.qty}× ${i.name}`).join(', ') : undefined,
    },
    {
      key: 'ack',
      title: 'Bếp nhận phiếu',
      where: 'kds',
      how: 'Màn hình bếp tự nhận phiếu. Không thấy phiếu: kiểm tra màn hình bếp đã ghép đúng trạm, hoặc xem mục Cảnh báo (phiếu in giấy).',
      done: count(ACKED) > 0,
      detail: `${count(ACKED)}/${total} món bếp đã nhận`,
    },
    {
      key: 'cooked',
      title: 'Bếp nấu xong',
      where: 'kds',
      how: 'Màn hình bếp: Nấu → Xong.',
      done: count(COOKED) > 0,
      detail: `${count(COOKED)}/${total} món đã xong`,
    },
    {
      key: 'robot',
      title: 'Robot nhận nhiệm vụ',
      where: 'robots',
      how: task && !task.robotCode ? 'Đã có task, đang chờ robot rảnh (online, pin ≥ 30%).' : 'Hệ thống tự tạo task và chọn robot. Theo dõi ở mục Robot.',
      done: staff || !!task?.robotCode,
      detail: staff ? 'Nhân viên mang món' : task?.robotCode ? `${task.code} · robot ${task.robotCode}` : undefined,
    },
    {
      key: 'loaded',
      title: 'Đặt món lên robot',
      where: 'robots',
      how: 'Khi robot "Tới điểm lấy món": đặt món lên khay → Đã đặt món lên robot (màn hình bếp hoặc mục Robot).',
      done: staff || (!!task && (!!task.loadedAt || LOADED.includes(task.status))),
      detail: task && !staff ? DELIVERY_STATUS_LABEL[task.status] : undefined,
    },
    {
      key: 'delivered',
      title: 'Giao tới khách',
      where: 'robots',
      how: 'Robot tới bàn: khách bấm "Đã nhận món" trên tablet, hoặc mục Robot → Xác nhận đã giao.',
      done: staff || (!!task && HANDED.includes(task.status)) || items.some((i) => i.status === 'DELIVERED'),
      detail: task?.confirmedBy ? CONFIRMED_BY[task.confirmedBy] : undefined,
    },
    {
      key: 'paid',
      title: 'Thanh toán',
      where: 'tables',
      how: `Bấm bàn ${code} → Bill & thanh toán → Khóa bill để thanh toán → Thu tiền mặt hoặc QR chuyển khoản.`,
      done: paid,
      detail: bills.length ? bills.map((b) => `${b.number} · ${formatVnd(b.total)}`).join(', ') : undefined,
    },
    {
      key: 'cleaned',
      title: 'Dọn bàn',
      where: 'tables',
      how: `Bấm bàn ${code} (Cần dọn) → Đã dọn xong — bàn sẵn sàng.`,
      done: closed && !!d.table && d.table.status !== 'CLEANING',
      detail: closed && d.table?.status === 'AVAILABLE' ? 'Bàn trống, sẵn sàng đón khách' : undefined,
    },
  ];
  return raw.map((s, i) => {
    const later = raw.slice(i + 1).some((r) => r.done);
    return { ...s, done: s.done || later, skipped: !s.done && later };
  });
}

function useWalkData(walk: WalkState) {
  const { api } = usePos();
  const sid = walk.sessionId;
  const live = { refetchInterval: 3000 };
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableDto[]>('/tables') });
  const session = useQuery({ queryKey: ['session', sid], queryFn: () => api.get<SessionDto>(`/sessions/${sid}`), enabled: !!sid, ...live });
  const orders = useQuery({ queryKey: ['orders', sid], queryFn: () => api.get<OrderDto[]>(`/sessions/${sid}/orders`), enabled: !!sid, ...live });
  const bills = useQuery({ queryKey: ['bill', sid, 'list'], queryFn: () => api.get<BillDto[]>(`/sessions/${sid}/bills`), enabled: !!sid, ...live });
  const tasks = useQuery({
    queryKey: ['delivery', 'walk', sid],
    queryFn: () => api.get<DeliveryTaskDto[]>(`/internal/delivery-tasks?active=false&sessionId=${sid}`),
    enabled: !!sid,
    ...live,
  });
  const table = tables.data?.find((t) => t.id === walk.tableId);
  return {
    table,
    task: tasks.data?.[0],
    steps: walkSteps({
      table,
      session: sid ? session.data : undefined,
      orders: orders.data ?? [],
      bills: bills.data ?? [],
      tasks: tasks.data ?? [],
    }),
  };
}

/** Bảng bước nổi ở góc màn hình POS, giữ nguyên khi chuyển mục để vừa làm vừa xem. */
export function WalkthroughPanel({
  walk,
  onChange,
  tab,
  onGoTab,
}: {
  walk: WalkState;
  onChange: (w: WalkState | null) => void;
  tab: string;
  onGoTab: (t: WalkTab) => void;
}) {
  const { table, task, steps } = useWalkData(walk);
  const [small, setSmall] = useState(false);

  // Bàn vừa được mở → nhớ phiên, để theo dõi tiếp cả sau khi thanh toán (bàn không còn phiên).
  useEffect(() => {
    if (!walk.sessionId && table?.sessionId) onChange({ ...walk, sessionId: table.sessionId });
  }, [walk, table?.sessionId, onChange]);

  const doneCount = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done);
  const trouble = task && (task.status === 'FAILED' || task.problem);

  if (small) {
    return (
      <button
        onClick={() => setSmall(false)}
        className="no-print fixed right-4 bottom-4 z-30 flex items-center gap-2 rounded-full bg-sen-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg"
      >
        Chạy thử bàn {table?.code} · {doneCount}/{steps.length}
        {current ? ` · ${current.title}` : ' · Hoàn tất'}
      </button>
    );
  }

  return (
    <section
      aria-label="Chạy thử toàn bộ luồng"
      className="no-print fixed right-4 bottom-4 z-30 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-stone-200"
    >
      <header className="flex items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
        <div>
          <div className="font-bold">Chạy thử · Bàn {table?.code ?? '…'}</div>
          <div className="text-xs text-stone-500">
            {doneCount}/{steps.length} bước
            {table && ` · bàn ${TABLE_STATUS_LABEL[table.status].toLowerCase()}`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-lg px-2 py-1 text-sm text-stone-500 hover:bg-stone-100" onClick={() => setSmall(true)} aria-label="Thu nhỏ">
            ▾
          </button>
          <button className="rounded-lg px-2 py-1 text-lg leading-none text-stone-500 hover:bg-stone-100" onClick={() => onChange(null)} aria-label="Dừng chạy thử">
            ×
          </button>
        </div>
      </header>
      <div className="h-1.5 bg-stone-100">
        <div className="h-full bg-la-500 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>

      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {steps.map((s, i) => {
          const isCurrent = s === current;
          return (
            <li key={s.key} className={`flex gap-3 rounded-xl p-2 ${isCurrent ? 'bg-sen-50 ring-1 ring-sen-200' : ''}`}>
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  s.done ? (s.skipped ? 'bg-stone-300 text-white' : 'bg-la-500 text-white') : isCurrent ? 'bg-sen-600 text-white' : 'bg-stone-100 text-stone-500'
                }`}
              >
                {s.done ? (s.skipped ? '–' : '✓') : i + 1}
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <div className={`font-semibold ${s.done || isCurrent ? '' : 'text-stone-500'}`}>
                  {s.title}
                  {s.skipped && <span className="font-normal text-stone-500"> · bỏ qua</span>}
                </div>
                {s.done && s.detail && <div className="truncate text-xs text-stone-500">{s.detail}</div>}
                {isCurrent && (
                  <>
                    <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-sen-700">{WHERE_LABEL[s.where]}</div>
                    <p className="text-stone-700">{s.how}</p>
                    {s.detail && s.key !== 'open' && <p className="mt-1 text-xs text-stone-500">{s.detail}</p>}
                    {trouble && ['robot', 'loaded', 'delivered'].includes(s.key) && (
                      <p className="mt-1 rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                        {task.problem ? DELIVERY_PROBLEM_LABEL[task.problem] : 'Giao món bị lỗi'} — mở mục Robot, chọn Thử lại / Giao robot khác / Nhân viên giao.
                      </p>
                    )}
                    {(s.where === 'tables' || s.where === 'robots' || s.where === 'alerts') && tab !== s.where && (
                      <Button size="sm" variant="secondary" className="mt-2" onClick={() => onGoTab(s.where as WalkTab)}>
                        Mở mục {WHERE_LABEL[s.where]}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {!current && (
        <div className="border-t border-stone-100 p-3 text-sm">
          <p className="font-semibold text-la-600">Hoàn tất! Toàn bộ luồng chạy đúng.</p>
          <Button size="sm" className="mt-2" onClick={() => onChange(null)}>
            Kết thúc chạy thử
          </Button>
        </div>
      )}
    </section>
  );
}

/** Trang "Chạy thử" trong màn hình hướng dẫn: chọn bàn rồi bắt đầu. */
export function WalkthroughStart({
  walk,
  onStart,
  onResume,
  onStop,
  go,
}: {
  walk: WalkState | null;
  onStart: (tableId: string) => void;
  onResume: () => void;
  onStop: () => void;
  go: (t: GuideTarget) => void;
}) {
  const { api } = usePos();
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableDto[]>('/tables') });
  const list = [...(tables.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, 'vi', { numeric: true }));
  const [picked, setPicked] = useState('');
  const tableId = picked || list.find((t) => t.status === 'AVAILABLE')?.id || list[0]?.id || '';
  const active = walk && list.find((t) => t.id === walk.tableId);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-5 ring-1 ring-stone-200 sm:p-7">
        <h1 className="text-2xl font-bold">Chạy thử toàn bộ luồng</h1>
        <p className="mt-3 text-stone-700">
          Chọn một bàn và làm lần lượt: <strong>mở bàn → gọi món → bếp → robot giao → thanh toán → dọn bàn</strong>. Bảng bước nổi ở góc màn hình tự đánh dấu khi
          bạn làm xong mỗi bước và chỉ chỗ cần bấm tiếp theo — dùng để tập huấn nhân viên mới hoặc kiểm tra hệ thống trước giờ mở bán.
        </p>
        <p className="mt-2 text-sm text-stone-500">
          Cần mở sẵn màn hình bếp (và tablet của bàn nếu có).{' '}
          <button className="font-medium text-sen-700 underline underline-offset-2" onClick={() => go({ doc: 'chay-thu' })}>
            Xem hướng dẫn chi tiết từng bước
          </button>
        </p>

        {active ? (
          <div className="mt-5 rounded-xl bg-sen-50 p-4">
            <p className="font-semibold">Đang chạy thử bàn {active.code}.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={onResume}>Tiếp tục theo dõi</Button>
              <Button variant="secondary" onClick={onStop}>
                Dừng chạy thử
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap items-end gap-2">
            <label className="min-w-48 flex-1">
              <span className="text-sm font-medium">Bàn chạy thử</span>
              <select className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5" value={tableId} onChange={(e) => setPicked(e.target.value)}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} · {TABLE_STATUS_LABEL[t.status]}
                  </option>
                ))}
              </select>
            </label>
            <Button disabled={!tableId} onClick={() => onStart(tableId)}>
              Bắt đầu chạy thử
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
