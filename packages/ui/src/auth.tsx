import { useState, type FormEvent } from 'react';
import { createApi, errorMessage } from './api';
import { Button, Logo } from './components';

const publicApi = createApi(() => null);

export function LoginScreen({ subtitle, onLogin }: { subtitle: string; onLogin: (token: string, name: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi.post<{ token: string; user: { name: string } }>('/auth/login', { username, password });
      onLogin(r.token, r.user.name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-stone-200">
        <Logo subtitle={subtitle} />
        <label className="block">
          <span className="text-sm font-medium">Tên đăng nhập</span>
          <input className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Mật khẩu</span>
          <input type="password" className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button className="w-full" disabled={busy || !username || !password}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </Button>
      </form>
    </div>
  );
}

export interface PairedDevice {
  id: string;
  kind: 'TABLET' | 'KDS';
  name: string;
  tableId: string | null;
  tableCode: string | null;
  station: string | null;
}

/** Ghép thiết bị bằng mã 6 số do nhân viên tạo trên POS. */
export function PairScreen({
  subtitle,
  kind,
  onPaired,
}: {
  subtitle: string;
  kind: 'TABLET' | 'KDS';
  onPaired: (token: string, device: PairedDevice) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await publicApi.post<{ token: string; device: PairedDevice }>('/devices/pair', { code, name: name || 'Thiết bị', kind });
      onPaired(r.token, r.device);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-stone-200">
        <Logo subtitle={subtitle} />
        <p className="text-sm text-stone-600">Nhập mã ghép 6 số do nhân viên tạo trên máy POS.</p>
        <input
          inputMode="numeric"
          maxLength={6}
          className="w-full rounded-xl border border-stone-300 px-3 py-3 text-center text-3xl font-bold tracking-[0.5em]"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-label="Mã ghép"
          autoFocus
        />
        <input className="w-full rounded-xl border border-stone-300 px-3 py-2.5" placeholder="Tên thiết bị (tùy chọn)" value={name} onChange={(e) => setName(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button className="w-full" disabled={busy || code.length !== 6}>
          {busy ? 'Đang ghép…' : 'Ghép thiết bị'}
        </Button>
      </form>
    </div>
  );
}
