import type {
  DeliveryEventDto,
  DeliveryTaskDto,
  ReadyGroupDto,
  RobotDto,
  RobotLocationDto,
  RobotTelemetry,
} from '@nhs/types';
import {
  Badge,
  Button,
  DELIVERY_PROBLEM_LABEL,
  DELIVERY_STATUS_LABEL,
  DELIVERY_STATUS_TONE,
  errorMessage,
  formatTime,
  ROBOT_STATE_LABEL,
} from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';

const ACTIVE = [
  'PENDING',
  'ASSIGNING',
  'ASSIGNED',
  'ROBOT_ACCEPTED',
  'GOING_TO_PICKUP',
  'ARRIVED_PICKUP',
  'LOADING',
  'GOING_TO_TABLE',
  'ARRIVED_TABLE',
  'WAITING_CUSTOMER',
  'DELIVERED',
  'RETURNING',
  'FAILED',
];
const FAULTS: [string, string][] = [
  ['OBSTACLE', 'Vật cản'],
  ['OBSTACLE_PERSISTENT', 'Kẹt hẳn'],
  ['OFFLINE', 'Mất kết nối'],
  ['LOW_BATTERY', 'Pin yếu'],
  ['API_TIMEOUT', 'Lỗi API'],
  ['BUTTON', 'Khách bấm nút'],
  ['RECOVER', 'Khôi phục'],
];
const VENDOR_LABEL: Record<string, string> = {
  MAKEBLOCK: 'mBot v1 (demo)',
  SIMULATED: 'Giả lập',
  ORIONSTAR: 'LuckiBot Pro',
  MANUAL: 'Điều khiển tay',
};
const COLORS = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8'];

/**
 * Điều phối robot giao món (MB-17, MB-20, RD-21): sa bàn, robot, task, xử lý lỗi.
 * Dùng chung cho mBot demo và LuckiBot — màn hình không phân biệt loại robot.
 */
export function Robots() {
  const { api } = usePos();
  const robots = useQuery({
    queryKey: ['robots'],
    queryFn: () => api.get<RobotDto[]>('/internal/robots'),
    refetchInterval: 10_000,
  });
  const tasks = useQuery({
    queryKey: ['delivery', 'tasks'],
    queryFn: () => api.get<DeliveryTaskDto[]>('/internal/delivery-tasks?active=false'),
    refetchInterval: 10_000,
  });
  const queue = useQuery({
    queryKey: ['delivery', 'queue'],
    queryFn: () => api.get<ReadyGroupDto[]>('/internal/delivery-queue'),
    refetchInterval: 10_000,
  });
  const locations = useQuery({
    queryKey: ['robot-locations'],
    queryFn: () => api.get<RobotLocationDto[]>('/internal/robot-locations'),
  });
  const telemetry = useQuery<Record<string, RobotTelemetry>>({
    queryKey: ['telemetry'],
    queryFn: () => ({}),
    staleTime: Infinity,
  });

  const all = tasks.data ?? [];
  const active = all.filter((t) => ACTIVE.includes(t.status));
  const recent = all.filter((t) => !ACTIVE.includes(t.status)).slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4">
      <h1 className="text-xl font-bold">Robot giao món</h1>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <SaBan
          robots={robots.data ?? []}
          locations={locations.data ?? []}
          telemetry={telemetry.data ?? {}}
          tasks={active}
        />
        <div className="space-y-3">
          {(robots.data ?? []).map((r, i) => (
            <RobotCard
              key={r.id}
              robot={r}
              color={COLORS[i % COLORS.length]}
              task={active.find((t) => t.id === r.taskId) ?? null}
              locations={locations.data ?? []}
            />
          ))}
        </div>
      </div>
      <Queue groups={queue.data ?? []} />
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Nhiệm vụ giao đang chạy ({active.length})</h2>
        {active.length === 0 && (
          <p className="rounded-2xl bg-white p-6 text-center text-stone-500 ring-1 ring-stone-200">
            Chưa có nhiệm vụ.
          </p>
        )}
        {active.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </section>
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Gần đây</h2>
          {recent.map((t) => (
            <TaskCard key={t.id} task={t} compact />
          ))}
        </section>
      )}
    </div>
  );
}

/** Sa bàn A1: vạch 0 = BẾP ở cạnh trái, 1–3 cạnh trên, 4 cạnh phải, 5 = TRẠM SẠC cạnh dưới; chạy theo chiều kim đồng hồ. */
const TRACK = { x: 110, y: 60, w: 340, h: 190, r: 45 };
const STOP_POS: Record<number, { x: number; y: number; label: 'left' | 'top' | 'right' | 'bottom' }> = {
  0: { x: TRACK.x, y: TRACK.y + TRACK.h / 2, label: 'left' },
  1: { x: TRACK.x + TRACK.w * 0.28, y: TRACK.y, label: 'top' },
  2: { x: TRACK.x + TRACK.w * 0.5, y: TRACK.y, label: 'top' },
  3: { x: TRACK.x + TRACK.w * 0.72, y: TRACK.y, label: 'top' },
  4: { x: TRACK.x + TRACK.w, y: TRACK.y + TRACK.h / 2, label: 'right' },
  5: { x: TRACK.x + TRACK.w / 2, y: TRACK.y + TRACK.h, label: 'bottom' },
};

function SaBan({
  robots,
  locations,
  telemetry,
  tasks,
}: {
  robots: RobotDto[];
  locations: RobotLocationDto[];
  telemetry: Record<string, RobotTelemetry>;
  tasks: DeliveryTaskDto[];
}) {
  const stopOf = new Map<string, number>();
  const nameAt = new Map<number, string>();
  for (const l of locations) {
    const s = (l.vendorMapping.MAKEBLOCK as { stop?: number } | undefined)?.stop;
    if (typeof s !== 'number') continue;
    stopOf.set(l.code, s);
    if (!nameAt.has(s) || l.kind !== 'HOME')
      nameAt.set(
        s,
        l.kind === 'KITCHEN_PASS' ? 'BẾP' : l.kind === 'CHARGER' ? 'TRẠM SẠC' : l.name.toUpperCase(),
      );
  }
  const onBoard = robots.filter((r) => r.vendor === 'MAKEBLOCK');
  const pos = (r: RobotDto) => {
    const t = telemetry[r.id];
    const loc = t?.location && t.location !== 'MOVING' ? t.location : r.location;
    const from = stopOf.get(loc ?? '') ?? 0;
    const to = t?.target ? stopOf.get(t.target) : undefined;
    const a = STOP_POS[from] ?? STOP_POS[0];
    if (to === undefined || t?.progress === undefined || t.progress === null) return a;
    const b = STOP_POS[to] ?? a;
    return { x: a.x + (b.x - a.x) * t.progress, y: a.y + (b.y - a.y) * t.progress };
  };
  const waitingAt = new Set(
    tasks
      .filter((t) => t.status === 'WAITING_CUSTOMER' || t.status === 'ARRIVED_TABLE')
      .map((t) => stopOf.get(t.deliveryLocation)),
  );

  return (
    <section className="rounded-2xl bg-white p-3 ring-1 ring-stone-200">
      <h2 className="px-1 text-sm font-semibold text-stone-600">
        Sa bàn demo (mBot v1) · chạy theo chiều kim đồng hồ
      </h2>
      <svg viewBox="0 0 560 310" className="w-full" role="img" aria-label="Sơ đồ sa bàn robot giao món">
        <rect
          x={TRACK.x}
          y={TRACK.y}
          width={TRACK.w}
          height={TRACK.h}
          rx={TRACK.r}
          fill="none"
          stroke="#1c1917"
          strokeWidth={14}
        />
        {Object.entries(STOP_POS).map(([k, p]) => {
          const n = Number(k);
          const vertical = p.label === 'top' || p.label === 'bottom';
          const lx = p.label === 'left' ? p.x - 58 : p.label === 'right' ? p.x + 58 : p.x;
          const ly = p.label === 'top' ? p.y - 26 : p.label === 'bottom' ? p.y + 34 : p.y + 4;
          return (
            <g key={k}>
              {n === 0 ? (
                <>
                  <rect x={p.x - 14} y={p.y - 14} width={28} height={6} fill="#1c1917" />
                  <rect x={p.x - 14} y={p.y + 8} width={28} height={6} fill="#1c1917" />
                </>
              ) : vertical ? (
                <rect x={p.x - 3} y={p.y - 16} width={6} height={32} fill="#1c1917" />
              ) : (
                <rect x={p.x - 16} y={p.y - 3} width={32} height={6} fill="#1c1917" />
              )}
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                fontSize={13}
                fontWeight={700}
                fill={n === 0 ? '#b45309' : n === 5 ? '#1d4ed8' : waitingAt.has(n) ? '#15803d' : '#0f766e'}
              >
                {nameAt.get(n) ?? `VẠCH ${n}`}
              </text>
              <text x={lx} y={ly + 13} textAnchor="middle" fontSize={9} fill="#78716c">
                vạch {n}
              </text>
            </g>
          );
        })}
        {onBoard.map((r, i) => {
          const p = pos(r);
          return (
            <g key={r.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r={12}
                fill={r.online ? COLORS[i % COLORS.length] : '#a8a29e'}
                stroke="white"
                strokeWidth={3}
              />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="white">
                {r.code}
              </text>
            </g>
          );
        })}
      </svg>
      {onBoard.length === 0 && (
        <p className="px-1 text-sm text-stone-500">
          Chưa có mBot nào. Robot giả lập chạy trên vòng ảo gồm tất cả các bàn.
        </p>
      )}
    </section>
  );
}

function useAction() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body: unknown = {}, ok?: string) => {
    setBusy(true);
    try {
      await api.post(path, body);
      if (ok) toast(ok, 'good');
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['robots'] });
      void qc.invalidateQueries({ queryKey: ['delivery'] });
    }
  };
  return { run, busy };
}

function RobotCard({
  robot: r,
  color,
  task,
  locations,
}: {
  robot: RobotDto;
  color: string;
  task: DeliveryTaskDto | null;
  locations: RobotLocationDto[];
}) {
  const { api, toast, role } = usePos();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [faults, setFaults] = useState(false);
  const locName =
    locations.find((l) => l.code === r.location)?.name ??
    (r.location === 'MOVING' ? 'Đang chạy' : r.location);
  const isManager = role === 'MANAGER' || role === 'ADMIN';
  const simulatable = r.vendor === 'SIMULATED' || r.vendor === 'MAKEBLOCK';

  async function enable(enabled: boolean) {
    try {
      await api.patch(`/internal/robots/${r.id}`, { enabled });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      void qc.invalidateQueries({ queryKey: ['robots'] });
    }
  }

  return (
    <article
      className="rounded-2xl bg-white p-4 ring-1 ring-stone-200"
      style={{ borderLeft: `6px solid ${r.online ? color : '#a8a29e'}` }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-bold">
            {r.code} · {r.name}
          </span>
          <span className="ml-2 text-xs text-stone-500">{VENDOR_LABEL[r.vendor] ?? r.vendor}</span>
        </div>
        <div className="flex items-center gap-1">
          {r.paused && <Badge tone="warn">Tạm dừng</Badge>}
          <Badge
            tone={
              r.state === 'DISABLED'
                ? 'neutral'
                : !r.online
                ? 'danger'
                : r.state === 'ERROR'
                  ? 'danger'
                  : r.state === 'BUSY'
                    ? 'accent'
                    : r.state === 'CHARGING'
                      ? 'info'
                      : 'good'
            }
          >
            {r.online ? ROBOT_STATE_LABEL[r.state] : 'Mất kết nối'}
          </Badge>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div>
          <div className="text-stone-500">Pin{r.telemetrySimulated && ' (giả lập)'}</div>
          <div className="mt-1 h-2 rounded-full bg-stone-100">
            <div
              className={`h-2 rounded-full ${r.battery < 15 ? 'bg-red-500' : r.battery < 30 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${r.battery}%` }}
            />
          </div>
          <div className="tabular-nums">{r.battery}%</div>
        </div>
        <div>
          <div className="text-stone-500">Vị trí</div>
          <div>{locName}</div>
          {task && (
            <div className="text-xs text-stone-500">
              {task.code} → bàn {task.tableCode}
            </div>
          )}
        </div>
      </div>
      {r.error && <p className="mt-2 text-sm text-red-700">{r.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !r.online}
          onClick={() => void run(`/internal/robots/${r.id}/stop`)}
          title="Dừng khẩn cấp: task chuyển lỗi chờ xử lý"
        >
          Dừng khẩn
        </Button>
        {r.paused ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void run(`/internal/robots/${r.id}/resume`)}
          >
            Chạy tiếp
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !r.online}
            onClick={() => void run(`/internal/robots/${r.id}/pause`)}
          >
            Tạm dừng
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !r.online}
          onClick={() => void run(`/internal/robots/${r.id}/return-home`, { charge: false })}
        >
          Về gốc
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !r.online}
          onClick={() => void run(`/internal/robots/${r.id}/return-home`, { charge: true })}
        >
          Về sạc
        </Button>
        {isManager && (
          <Button size="sm" variant="ghost" onClick={() => void enable(r.state === 'DISABLED')}>
            {r.state === 'DISABLED' ? 'Bật robot' : 'Tạm ngưng'}
          </Button>
        )}
        {simulatable && (
          <Button size="sm" variant="ghost" onClick={() => setFaults(!faults)} aria-expanded={faults}>
            Giả lập lỗi
          </Button>
        )}
      </div>
      {faults && (
        <div
          className="mt-2 flex flex-wrap gap-1 rounded-xl bg-stone-50 p-2"
          aria-label="Giả lập lỗi (MB-16)"
        >
          {FAULTS.map(([f, label]) => (
            <Button
              key={f}
              size="sm"
              variant={f === 'RECOVER' ? 'good' : 'secondary'}
              disabled={busy}
              onClick={() =>
                void run(`/internal/robots/${r.id}/simulate`, { fault: f }, `Đã giả lập: ${label}`)
              }
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </article>
  );
}

function Queue({ groups }: { groups: ReadyGroupDto[] }) {
  const { run, busy } = useAction();
  if (groups.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-bold">Món xong chờ giao</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {groups.map((g) => (
          <article key={g.sessionId} className="rounded-2xl bg-white p-3 ring-1 ring-stone-200">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Bàn {g.tableCode ?? '—'}</span>
              <span className="text-sm text-stone-500">
                chờ {Math.round(g.waitingSeconds / 60)} phút
                {g.stillCooking ? ` · còn ${g.stillCooking} món đang nấu` : ''}
              </span>
            </div>
            <p className="my-1 text-sm">
              {g.items
                .map((i) => `${i.qty}× ${i.name}${i.deliveryMode === 'STAFF' ? ' (nhân viên)' : ''}`)
                .join(', ')}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    '/internal/delivery-tasks',
                    { orderItemIds: g.items.filter((i) => i.deliveryMode === 'ROBOT').map((i) => i.id) },
                    'Đã tạo nhiệm vụ robot',
                  )
                }
              >
                Giao bằng robot
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run('/internal/delivery-items/staff', { orderItemIds: g.items.map((i) => i.id) })
                }
              >
                Nhân viên mang
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/** Một delivery task với các thao tác theo trạng thái (MB-17: RETRY / REASSIGN / STAFF DELIVERY / CANCEL). */
function TaskCard({ task: t, compact }: { task: DeliveryTaskDto; compact?: boolean }) {
  const { api } = usePos();
  const { run, busy } = useAction();
  const [log, setLog] = useState(false);
  const events = useQuery({
    queryKey: ['delivery', 'events', t.id],
    queryFn: () => api.get<DeliveryEventDto[]>(`/internal/delivery-tasks/${t.id}/events`),
    enabled: log,
  });
  const ask = (q: string) => window.prompt(q)?.trim();
  const base = `/internal/delivery-tasks/${t.id}`;
  const done = ['COMPLETED', 'CANCELLED', 'MANUAL_TAKEOVER', 'DELIVERED', 'RETURNING'].includes(t.status);

  return (
    <article
      className={`rounded-2xl bg-white p-4 ring-1 ${t.status === 'FAILED' ? 'ring-2 ring-red-300' : t.problem ? 'ring-2 ring-amber-300' : 'ring-stone-200'} ${compact ? 'py-2' : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-bold">{t.code}</span> · Bàn {t.tableCode}
          <span className="text-sm text-stone-500">
            {' '}
            · {t.robotCode ? `robot ${t.robotCode}` : 'chưa có robot'} · tạo {formatTime(t.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {t.problem && <Badge tone="warn">{DELIVERY_PROBLEM_LABEL[t.problem]}</Badge>}
          <Badge tone={DELIVERY_STATUS_TONE[t.status]}>{DELIVERY_STATUS_LABEL[t.status]}</Badge>
        </div>
      </div>
      {!compact && (
        <>
          <p className="mt-1 text-sm">{t.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</p>
          {t.failureReason && <p className="mt-1 text-sm text-red-700">{t.failureReason}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {t.status === 'ARRIVED_PICKUP' && (
              <Button size="sm" disabled={busy} onClick={() => void run(`${base}/confirm-loaded`)}>
                Đã đặt món lên robot
              </Button>
            )}
            {(t.status === 'ARRIVED_TABLE' || t.status === 'WAITING_CUSTOMER') && (
              <Button
                size="sm"
                variant="good"
                disabled={busy}
                onClick={() => void run(`${base}/confirm-delivered`, {}, 'Đã xác nhận giao')}
              >
                Xác nhận đã giao
              </Button>
            )}
            {t.status === 'FAILED' && (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(`${base}/retry`, {}, 'Đã gửi lại lệnh')}
                >
                  Thử lại
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run(`${base}/reassign`, {}, 'Chờ robot khác')}
                >
                  Giao robot khác
                </Button>
              </>
            )}
            {!done && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const reason = ask('Lý do chuyển nhân viên giao?');
                  if (reason) void run(`${base}/manual-takeover`, { reason }, 'Nhân viên mang món ra');
                }}
              >
                Nhân viên giao
              </Button>
            )}
            {[
              'PENDING',
              'ASSIGNED',
              'ROBOT_ACCEPTED',
              'GOING_TO_PICKUP',
              'ARRIVED_PICKUP',
              'FAILED',
            ].includes(t.status) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  const reason = ask('Lý do hủy nhiệm vụ robot?');
                  if (reason) void run(`${base}/cancel`, { reason });
                }}
              >
                Hủy
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setLog(!log)} aria-expanded={log}>
              Nhật ký
            </Button>
          </div>
          {log && (
            <ol className="mt-3 space-y-1 border-l-2 border-stone-200 pl-3 text-sm">
              {(events.data ?? []).map((e) => (
                <li key={e.id}>
                  <span className="tabular-nums text-stone-500">
                    {new Date(e.createdAt).toLocaleTimeString('vi-VN')}
                  </span>{' '}
                  <b>{e.type}</b>
                  {e.location && <span className="text-stone-500"> · {e.location}</span>}
                  {e.payload && Object.keys(e.payload).length > 0 && (
                    <span className="text-stone-500"> · {JSON.stringify(e.payload)}</span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </article>
  );
}
