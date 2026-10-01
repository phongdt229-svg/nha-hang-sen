import { Badge, Button, errorMessage, formatTime, Modal } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
}

interface DeviceRow {
  id: string;
  kind: 'TABLET' | 'KDS' | 'PRINTER';
  name: string;
  tableCode: string | null;
  station: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Chủ quán',
  MANAGER: 'Quản lý ca',
  CASHIER: 'Thu ngân',
  WAITER: 'Phục vụ / lễ tân',
  KITCHEN: 'Bếp',
  HEAD_CHEF: 'Bếp trưởng',
  STOREKEEPER: 'Thủ kho',
  ACCOUNTANT: 'Kế toán',
};
const DEVICE_LABEL = { TABLET: 'Tablet', KDS: 'Màn hình bếp', PRINTER: 'Print agent' };
const field = 'mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5';

/** Nhân viên tự đổi mật khẩu (sau lần đăng nhập đầu bằng mật khẩu chủ quán cấp). */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const { api, toast } = usePos();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const mismatch = f.confirm.length > 0 && f.confirm !== f.newPassword;
  async function save() {
    setBusy(true);
    try {
      await api.post('/auth/password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      toast('Đã đổi mật khẩu', 'good');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Đổi mật khẩu" onClose={onClose}>
      <div className="space-y-3">
        {(['currentPassword', 'newPassword', 'confirm'] as const).map((k) => (
          <label key={k} className="block">
            <span className="text-sm font-medium">{k === 'currentPassword' ? 'Mật khẩu hiện tại' : k === 'newPassword' ? 'Mật khẩu mới (tối thiểu 8 ký tự)' : 'Nhập lại mật khẩu mới'}</span>
            <input type="password" autoComplete={k === 'currentPassword' ? 'current-password' : 'new-password'} className={field} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        {mismatch && <p className="text-sm text-red-700">Hai lần nhập mật khẩu mới không khớp.</p>}
        <Button className="w-full" disabled={busy || !f.currentPassword || f.newPassword.length < 8 || f.confirm !== f.newPassword} onClick={() => void save()}>
          Đổi mật khẩu
        </Button>
      </div>
    </Modal>
  );
}

/** Nhân viên (chủ quán) và thiết bị đã ghép (quản lý) — mục 9. */
export function Accounts() {
  const { role } = usePos();
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      {role === 'ADMIN' && <Users />}
      <Devices />
    </div>
  );
}

function Users() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/users') });
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);

  async function toggle(u: UserRow) {
    if (u.active && !window.confirm(`Khóa tài khoản ${u.name}? Người này bị đăng xuất ngay.`)) return;
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      void qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Nhân viên</h1>
        <Button onClick={() => setEditing('new')}>Thêm nhân viên</Button>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2 font-medium">Tên</th>
              <th className="px-4 py-2 font-medium">Đăng nhập</th>
              <th className="px-4 py-2 font-medium">Vai trò</th>
              <th className="px-4 py-2 font-medium">Trạng thái</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {(q.data ?? []).map((u) => (
              <tr key={u.id} className={u.active ? '' : 'text-stone-400'}>
                <td className="px-4 py-2">{u.name}</td>
                <td className="px-4 py-2 font-mono">{u.username}</td>
                <td className="px-4 py-2">{ROLE_LABEL[u.role] ?? u.role}</td>
                <td className="px-4 py-2">{u.active ? <Badge tone="good">Đang làm</Badge> : <Badge>Đã khóa</Badge>}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                    Sửa
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(u)}>
                    {u.active ? 'Khóa' : 'Mở khóa'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function UserForm({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [f, setF] = useState({ username: user?.username ?? '', name: user?.name ?? '', role: user?.role ?? 'WAITER', password: '' });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      if (user) await api.patch(`/users/${user.id}`, { name: f.name, role: f.role, ...(f.password ? { password: f.password } : {}) });
      else await api.post('/users', f);
      toast(user ? 'Đã lưu' : `Đã tạo tài khoản ${f.username}`, 'good');
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const pwOk = user ? f.password === '' || f.password.length >= 8 : f.password.length >= 8;
  return (
    <Modal title={user ? `Sửa ${user.name}` : 'Thêm nhân viên'} onClose={onClose}>
      <div className="space-y-3">
        {!user && (
          <label className="block">
            <span className="text-sm font-medium">Tên đăng nhập (chữ thường, số, . _ -)</span>
            <input className={field} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} />
          </label>
        )}
        <label className="block">
          <span className="text-sm font-medium">Họ tên</span>
          <input className={field} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Vai trò</span>
          <select className={field} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">{user ? 'Đặt lại mật khẩu (để trống nếu không đổi)' : 'Mật khẩu tạm (tối thiểu 8 ký tự)'}</span>
          <input type="text" autoComplete="off" className={field} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </label>
        <p className="text-xs text-stone-500">Đưa mật khẩu tạm cho nhân viên và nhắc họ đổi ngay sau lần đăng nhập đầu.</p>
        <Button className="w-full" disabled={busy || !f.name || (!user && !f.username) || !pwOk} onClick={() => void save()}>
          Lưu
        </Button>
      </div>
    </Modal>
  );
}

function Devices() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['devices'], queryFn: () => api.get<DeviceRow[]>('/devices') });
  const [showRevoked, setShowRevoked] = useState(false);
  const [creating, setCreating] = useState(false);
  const rows = (q.data ?? []).filter((d) => showRevoked || !d.revokedAt);

  async function revoke(d: DeviceRow) {
    if (!window.confirm(`Thu hồi ${DEVICE_LABEL[d.kind]} "${d.name}"? Thiết bị phải ghép lại mới dùng được.`)) return;
    try {
      await api.post(`/devices/${d.id}/revoke`);
      toast('Đã thu hồi thiết bị', 'good');
      void qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Thiết bị đã ghép</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> Hiện cả thiết bị đã thu hồi
          </label>
          <Button onClick={() => setCreating(true)}>Tạo mã ghép</Button>
        </div>
      </div>
      <p className="text-sm text-stone-600">Tablet mất, hỏng hoặc thay mới: thu hồi để token cũ hết hiệu lực, rồi ghép thiết bị mới.</p>
      <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              <th className="px-4 py-2 font-medium">Loại</th>
              <th className="px-4 py-2 font-medium">Tên</th>
              <th className="px-4 py-2 font-medium">Gắn với</th>
              <th className="px-4 py-2 font-medium">Ghép lúc</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-stone-500">
                  Chưa có thiết bị.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className={d.revokedAt ? 'text-stone-400' : ''}>
                <td className="px-4 py-2">{DEVICE_LABEL[d.kind]}</td>
                <td className="px-4 py-2">{d.name}</td>
                <td className="px-4 py-2">{d.tableCode ? `Bàn ${d.tableCode}` : (d.station ?? '—')}</td>
                <td className="px-4 py-2">
                  {new Date(d.createdAt).toLocaleDateString('vi-VN')} {formatTime(d.createdAt)}
                </td>
                <td className="px-4 py-2 text-right">
                  {d.revokedAt ? (
                    <Badge>Đã thu hồi</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void revoke(d)}>
                      Thu hồi
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <CreatePairingCodeModal onClose={() => { setCreating(false); void qc.invalidateQueries({ queryKey: ['devices'] }); }} />}
    </section>
  );
}

function CreatePairingCodeModal({ onClose }: { onClose: () => void }) {
  const { api, toast } = usePos();
  const [kind, setKind] = useState<'KDS' | 'TABLET'>('KDS');
  const [station, setStation] = useState('BEP_NONG');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const body = kind === 'KDS' ? { kind, station } : { kind, tableId: '' };
      const res = await api.post<{ code: string; expiresAt: string }>('/devices/pairing-codes', body);
      setCode(res.code);
    } catch (e) {
      toast(errorMessage(e));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (code) {
    return (
      <Modal title="Mã ghép đã tạo" onClose={onClose}>
        <div className="space-y-4 text-center">
          <p className="text-sm text-stone-600">Sử dụng mã này trên {kind === 'KDS' ? 'màn hình bếp' : 'tablet'} (hết hạn sau 10 phút)</p>
          <div className="rounded-xl bg-blue-50 p-4 text-3xl font-bold tracking-widest text-blue-900">{code}</div>
          <Button className="w-full" onClick={onClose}>Đóng</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Tạo mã ghép thiết bị" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium">Loại thiết bị</span>
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as 'KDS' | 'TABLET')}>
            <option value="KDS">Màn hình bếp (KDS)</option>
            <option value="TABLET">Tablet gọi món</option>
          </select>
        </label>
        {kind === 'KDS' && (
          <label className="block">
            <span className="text-sm font-medium">Trạm bếp</span>
            <select className={field} value={station} onChange={(e) => setStation(e.target.value)}>
              <option value="BEP_NONG">Bếp nóng</option>
              <option value="BEP_LANH">Bếp lạnh</option>
              <option value="QUAY_BAR">Quầy bar</option>
            </select>
          </label>
        )}
        <Button className="w-full" disabled={busy} onClick={() => void create()}>
          Tạo mã
        </Button>
      </div>
    </Modal>
  );
}
