import type { DomainEvent, KitchenTicketDto, TableDto } from '@nhs/types';
import { Button, ConnectionDot, createApi, LoginScreen, Logo, storage, useRealtime, useToast } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Alerts } from './Alerts';
import { Pos } from './context';
import { Overview } from './Overview';
import { TableMap } from './TableMap';

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

type Tab = 'tables' | 'alerts' | 'overview';

function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const api = useMemo(() => createApi(() => token, onLogout), [token, onLogout]);
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('tables');

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api.get<TableDto[]>('/tables') });
  const fallback = useQuery({ queryKey: ['fallback'], queryFn: () => api.get<KitchenTicketDto[]>('/kitchen/fallback') });

  const connected = useRealtime({ token, storageKey: 'pos' }, (e: DomainEvent) => {
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
  });

  const alertCount = fallback.data?.length ?? 0;
  const tabs: [Tab, string][] = [
    ['tables', 'Sơ đồ bàn'],
    ['alerts', `Cảnh báo bếp${alertCount ? ` (${alertCount})` : ''}`],
    ['overview', 'Tổng quan'],
  ];

  return (
    <Pos.Provider value={{ api, role: me.data?.role ?? '', toast: toast.show }}>
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
            <ConnectionDot connected={connected} />
            <span className="hidden text-sm text-stone-600 sm:inline">{me.data?.name}</span>
            <Button size="sm" variant="ghost" onClick={onLogout}>
              Đăng xuất
            </Button>
          </div>
        </header>
        <main className="flex-1">
          {tab === 'tables' && <TableMap tables={tables.data ?? []} />}
          {tab === 'alerts' && <Alerts tickets={fallback.data ?? []} />}
          {tab === 'overview' && <Overview />}
        </main>
        {toast.node}
      </div>
    </Pos.Provider>
  );
}
