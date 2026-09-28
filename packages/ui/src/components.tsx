import { useCallback, useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Tone } from './labels';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'good';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-sen-600 text-white hover:bg-sen-700 disabled:bg-sen-200',
  secondary: 'bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 disabled:text-stone-400',
  ghost: 'text-stone-700 hover:bg-stone-100 disabled:text-stone-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-200',
  good: 'bg-la-600 text-white hover:bg-la-500 disabled:bg-emerald-200',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-sm' : size === 'lg' ? 'px-5 py-3.5 text-lg' : 'px-4 py-2.5';
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors ${sz} ${VARIANT[variant]} ${className}`}
    />
  );
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700',
  info: 'bg-sky-100 text-sky-800',
  warn: 'bg-amber-100 text-amber-900',
  accent: 'bg-sen-100 text-sen-700',
  good: 'bg-emerald-100 text-emerald-800',
  muted: 'bg-stone-100 text-stone-400 line-through',
  danger: 'bg-red-100 text-red-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="no-print fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-md'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Đóng" className="rounded-lg px-2 py-1 text-2xl leading-none text-stone-500 hover:bg-stone-100">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-stone-500" title={connected ? 'Đang kết nối' : 'Mất kết nối, đang thử lại'}>
      <span className={`size-2 rounded-full ${connected ? 'bg-la-500' : 'animate-pulse bg-red-500'}`} />
      {connected ? 'Trực tuyến' : 'Mất kết nối'}
    </span>
  );
}

export function Toast({ message, tone = 'danger', onDone }: { message: string; tone?: 'danger' | 'good'; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div
      role="status"
      className={`no-print fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ${tone === 'good' ? 'bg-la-600' : 'bg-red-600'}`}
    >
      {message}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; tone: 'danger' | 'good' } | null>(null);
  const show = useCallback((message: string, tone: 'danger' | 'good' = 'danger') => setToast({ message, tone }), []);
  const done = useCallback(() => setToast(null), []);
  const node = useMemo(() => (toast ? <Toast message={toast.message} tone={toast.tone} onDone={done} /> : null), [toast, done]);
  return { show, node };
}

export function Logo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <path d="M16 5c3 4 4.5 8 4.5 11.5S18.5 24 16 26c-2.5-2-4.5-6-4.5-9.5S13 9 16 5Z" fill="var(--color-sen-500)" />
        <path d="M5 13c4 0 7.5 2 9.5 5.5.9 1.6 1.5 4.5 1.5 7.5-5 0-11-4-11-13Z" fill="var(--color-sen-400)" />
        <path d="M27 13c-4 0-7.5 2-9.5 5.5-.9 1.6-1.5 4.5-1.5 7.5 5 0 11-4 11-13Z" fill="var(--color-sen-400)" />
      </svg>
      <div className="leading-tight">
        <div className="font-bold text-sen-700">Nhà hàng Sen</div>
        {subtitle && <div className="text-xs text-stone-500">{subtitle}</div>}
      </div>
    </div>
  );
}
