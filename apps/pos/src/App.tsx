import type { DomainEvent, KitchenTicketDto, RobotTelemetry, TableDto } from '@nhs/types';
import {
  Button,
  ConnectionDot,
  createApi,
  GuideView,
  HelpButton,
  LoginScreen,
  Logo,
  ROLE_GUIDE,
  storage,
  useRealtime,
  useToast,
  type GuideId,
  type GuideTarget,
} from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Accounts, ChangePassword } from './Accounts';
import { Alerts } from './Alerts';
import { Backup } from './Backup';
import { Pos } from './context';
import { Overview } from './Overview';
import { printerProblem, type PrintStatus } from './Printing';
import { Reports } from './Reports';
import { Robots } from './Robots';
import { ShiftScreen } from './Shift';
import { TableMap } from './TableMap';
import { loadWalk, saveWalk, WalkthroughPanel, WalkthroughStart, type WalkState } from './Walkthrough';

const TOKEN_KEY = 'nhs.pos.token';

interface Me {
  kind: 'user';
  sub: string;
  role: string;
  name: string;
}

export function App() {
  const [token, setToken] = useState(() => storage.get(TOKEN_KEY));
  const logout = useCallback(() => {
    storage.set(TOKEN_KEY, null);
    setToken(null);
  }, []);
  if (!token) {
    return (
      <LoginScreen
        subtitle="POS thu ngân & lễ tân"
        onLogin={(t) => {
          storage.set(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }
  return <Shell token={token} onLogout={logout} />;
}

type Tab = 'tables' | 'alerts' | 'robots' | 'overview' | 'shift' | 'reports' | 'accounts' | 'backup';

/** Mục hiện theo vai trò (mục 9): kế toán chỉ xem báo cáo, phục vụ không thu tiền. */
const TAB_ROLES: Record<Tab, string[]> = {
  tables: ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],
  alerts: ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],
  robots: ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],
  overview: ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER'],
  shift: ['ADMIN', 'MANAGER', 'CASHIER'],
  reports: ['ADMIN', 'MANAGER', 'ACCOUNTANT'],
  accounts: ['ADMIN', 'MANAGER'],
  backup: ['ADMIN'],
};

const POS_GUIDES: GuideId[] = ['dao-tao', 'chay-thu', 'phuc-vu', 'thu-ngan', 'quan-ly', 'ke-toan-chu-quan', 'bep', 'khach-hang', 'runbook', 'robot-demo'];

/** Mở hướng dẫn đúng chỗ theo mục đang xem (HD-04); mục khác mở hướng dẫn của vai trò. */
function guideFor(tab: Tab | undefined, role: string): GuideTarget {
  const own = ROLE_GUIDE[role] ?? 'phuc-vu';
  switch (tab) {
    case 'alerts':
      return { doc: 'runbook' };
    case 'robots':
      return { doc: 'phuc-vu', anchor: 'giao-món' };
    case 'shift':
      return role === 'CASHIER' ? { doc: 'thu-ngan', anchor: 'đầu-ca' } : { doc: 'quan-ly', anchor: 'cuối-ngày' };
    case 'reports':
      return role === 'ACCOUNTANT' ? { doc: 'ke-toan-chu-quan' } : { doc: 'quan-ly', anchor: 'báo-cáo' };
    case 'accounts':
      return { doc: 'quan-ly', anchor: 'thao-tác-cần-quyền-quản-lý' };
    default:
      return { doc: own };
  }
}

function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = useMemo(() => createApi(() => token, onLogout), [token, onLogout]);
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setTab] = useState<Tab | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [walk, setWalkState] = useState<WalkState | null>(loadWalk);
  const setWalk = useCallback((w: WalkState | null) => {
    saveWalk(w);
    setWalkState(w);
  }, []);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });
  const role = me.data?.role ?? '';
  const floor = TAB_ROLES.tables.includes(role);
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableDto[]>('/tables'), enabled: floor });
  const fallback = useQuery({ queryKey: ['fallback'], queryFn: () => api.get<KitchenTicketDto[]>('/kitchen/fallback'), enabled: floor });
  const invoiceAlerts = useQuery({
    queryKey: ['einvoices', 'attention'],
    queryFn: () => api.get<{ status: string }[]>('/einvoices/attention'),
    enabled: floor && role !== 'WAITER',
  });

  const connected = useRealtime(
    { token, storageKey: 'pos' },
    (e: DomainEvent) => {
    if (e.type.startsWith('delivery.') || e.type === 'robot.status') {
      void qc.invalidateQueries({ queryKey: ['delivery'] });
      void qc.invalidateQueries({ queryKey: ['robots'] });
    }
    if (e.type === 'delivery.task.failed') toast.show('Giao món bằng robot bị lỗi — mở mục Robot để xử lý.');
    if (e.type === 'delivery.customer.timeout') toast.show('Robot đang chờ khách nhận món quá lâu — mở mục Robot.');
    if (e.type === 'table.status' || e.type.startsWith('session.')) void qc.invalidateQueries({ queryKey: ['tables'] });
    if (e.type.startsWith('session.') || e.type.startsWith('bill.')) void qc.invalidateQueries({ queryKey: ['session'] });
    if (e.type === 'kitchen.fallback') toast.show(`Bếp chưa nhận order! Kiểm tra mục Cảnh báo bếp.`);
    if (e.type === 'kitchen.fallback' || e.type === 'kitchen.ack') void qc.invalidateQueries({ queryKey: ['fallback'] });
    if (e.type.startsWith('order.') || e.type.startsWith('kitchen.')) void qc.invalidateQueries({ queryKey: ['orders'] });
    if (e.type.startsWith('order.') || e.type.startsWith('bill.') || e.type.startsWith('payment.')) {
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    }
    if (e.type.startsWith('menu.')) void qc.invalidateQueries({ queryKey: ['menu'] });
    if (e.type === 'shift.closed' || e.type.startsWith('payment.')) void qc.invalidateQueries({ queryKey: ['shift'] });
    if (e.type === 'bill.paid' || e.type === 'payment.refunded' || e.type === 'business_day.closed') void qc.invalidateQueries({ queryKey: ['report'] });
    if (e.type.startsWith('einvoice.')) {
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    }
    if (e.type.startsWith('print.')) void qc.invalidateQueries({ queryKey: ['print'] });
    if (e.type === 'print.failed') toast.show('Máy in gặp sự cố — lệnh in đang chờ trong hàng đợi. Xem mục Cảnh báo.');
    if (e.type === 'einvoice.failed') toast.show('Hóa đơn điện tử bị từ chối — xem mục Cảnh báo.');
    },
    {
      // Vị trí tức thời của robot (không lưu sổ) để vẽ trên sa bàn.
      'robot.telemetry': (t: RobotTelemetry) =>
        qc.setQueryData<Record<string, RobotTelemetry>>(['telemetry'], (old) => ({ ...(old ?? {}), [t.robotId]: t })),
    },
  );

  const printStatus = useQuery({ queryKey: ['print'], queryFn: () => api.get<PrintStatus>('/print/status'), refetchInterval: 15_000, enabled: floor });
  const alertCount =
    (fallback.data?.length ?? 0) +
    (invoiceAlerts.data?.filter((i) => i.status === 'FAILED').length ?? 0) +
    (printStatus.data?.printers.filter(printerProblem).length ?? 0);
  const tabs = (
    [
      ['tables', 'Sơ đồ bàn'],
      ['alerts', `Cảnh báo${alertCount ? ` (${alertCount})` : ''}`],
      ['robots', 'Robot'],
      ['overview', 'Tổng quan'],
      ['shift', 'Ca làm'],
      ['reports', 'Báo cáo'],
      ['accounts', role === 'ADMIN' ? 'Nhân viên & thiết bị' : 'Thiết bị'],
      ['backup', '🔄 Sao lưu'],
    ] as [Tab, string][]
  ).filter(([t]) => TAB_ROLES[t].includes(role));
  const tab = picked && tabs.some(([t]) => t === picked) ? picked : tabs[0]?.[0];

  return (
    <Pos.Provider value={{ api, role, toast: toast.show }}>
      <div className="flex min-h-full flex-col">
        <header className="no-print sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3">
          <Logo subtitle="POS thu ngân & lễ tân" />
          <nav className="flex gap-1 overflow-x-auto rounded-xl bg-stone-100 p-1" aria-label="Chuyển mục">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${tab === key ? 'bg-white text-sen-700 shadow-sm' : 'text-stone-600'} ${key === 'alerts' && alertCount ? 'text-red-600' : ''}`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <HelpButton onClick={() => setGuideOpen(true)} />
            <ConnectionDot connected={connected} />
            <button className="hidden text-sm text-stone-600 underline-offset-2 hover:underline sm:inline" title="Đổi mật khẩu" onClick={() => setChangingPassword(true)}>
              {me.data?.name}
            </button>
            <Button size="sm" variant="ghost" onClick={onLogout}>
              Đăng xuất
            </Button>
          </div>
        </header>
        <main className="flex-1">
          {tab === 'tables' && <TableMap tables={tables.data ?? []} />}
          {tab === 'alerts' && <Alerts tickets={fallback.data ?? []} />}
          {tab === 'robots' && <Robots />}
          {tab === 'overview' && <Overview />}
          {tab === 'shift' && <ShiftScreen />}
          {tab === 'reports' && <Reports />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'backup' && <Backup />}
        </main>
        {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
        {floor && walk && <WalkthroughPanel walk={walk} onChange={setWalk} tab={tab ?? ''} onGoTab={setTab} />}
        {guideOpen && (
          <GuideView
            docs={[ROLE_GUIDE[role] ?? 'phuc-vu', ...POS_GUIDES.filter((d) => d !== (ROLE_GUIDE[role] ?? 'phuc-vu'))]}
            initial={guideFor(tab, role)}
            extras={
              floor
                ? [
                    {
                      id: 'chay-thu-truc-tiep',
                      title: 'Chạy thử (theo dõi trực tiếp)',
                      render: (go) => (
                        <WalkthroughStart
                          walk={walk}
                          go={go}
                          onStart={(tableId) => {
                            const t = tables.data?.find((x) => x.id === tableId);
                            setWalk({ tableId, sessionId: t?.sessionId ?? null, startedAt: new Date().toISOString() });
                            setTab('tables');
                            setGuideOpen(false);
                          }}
                          onResume={() => setGuideOpen(false)}
                          onStop={() => setWalk(null)}
                        />
                      ),
                    },
                  ]
                : []
            }
            progressKey={me.data?.sub}
            onClose={() => setGuideOpen(false)}
          />
        )}
        {toast.node}
      </div>
    </Pos.Provider>
  );
}
