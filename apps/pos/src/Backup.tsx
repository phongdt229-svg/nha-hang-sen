import { Button, Badge, formatTime } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';

interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
  path: string;
}

export function Backup() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupInfo[]>('/admin/backup/list') });
  const [busy, setBusy] = useState(false);

  async function createBackup() {
    if (!window.confirm('Backup sẽ mất vài giây. Tiếp tục?')) return;
    setBusy(true);
    try {
      const res = await api.post<{ success: boolean; filename: string }>('/admin/backup/create', {});
      toast(`Backup tạo thành công: ${res.filename}`, 'good');
      void qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(`Backup thất bại: ${message || 'Lỗi không xác định'}`);
    } finally {
      setBusy(false);
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">🔄 Sao lưu & Khôi phục</h1>
            <p className="text-sm text-stone-600 mt-1">Backup tự động mỗi ngày, lưu 30 phiên gần nhất</p>
          </div>
          <Button onClick={() => void createBackup()} disabled={busy} className="bg-blue-600 text-white">
            {busy ? '⏳ Đang sao lưu...' : '💾 Sao lưu ngay'}
          </Button>
        </div>

        {q.isLoading ? (
          <div className="text-center py-8 text-stone-500">Đang tải danh sách...</div>
        ) : q.data && q.data.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-stone-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Tệp</th>
                  <th className="px-4 py-2 font-medium">Kích thước</th>
                  <th className="px-4 py-2 font-medium">Ngày tạo</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {q.data.map((b, i) => (
                  <tr key={b.filename} className={i === 0 ? 'bg-blue-50' : ''}>
                    <td className="px-4 py-2 font-mono text-xs">{b.filename}</td>
                    <td className="px-4 py-2">{formatSize(b.size)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {new Date(b.createdAt).toLocaleDateString('vi-VN')} {formatTime(b.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {i === 0 && <Badge tone="good">Mới nhất</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 rounded-2xl bg-stone-50 text-stone-500">
            Chưa có backup nào
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl bg-amber-50 p-4 border border-amber-200">
        <h2 className="font-bold text-amber-900">⚠️ Khôi phục dữ liệu</h2>
        <p className="text-sm text-amber-800">
          Để khôi phục từ backup, chạy lệnh sau trong terminal (ngừng API trước):
        </p>
        <pre className="bg-white p-3 rounded text-xs font-mono overflow-x-auto border border-amber-200">
{`# 1. Dừng API & containers
docker-compose down

# 2. Khôi phục
bash ./infra/restore.sh infra/backups/backup_YYYYMMDD_HHMMSS.sql.gz

# 3. Khởi động lại
docker-compose up -d`}
        </pre>
      </section>

      <section className="space-y-3 rounded-2xl bg-green-50 p-4 border border-green-200">
        <h2 className="font-bold text-green-900">✅ Tự động sao lưu hàng ngày</h2>
        <p className="text-sm text-green-800">
          Thêm cronjob trên máy chủ để backup tự động mỗi ngày lúc 2 AM:
        </p>
        <pre className="bg-white p-3 rounded text-xs font-mono overflow-x-auto border border-green-200">
{`0 2 * * * cd /app && bash ./infra/backup.sh > /var/log/backup.log 2>&1`}
        </pre>
      </section>
    </div>
  );
}
