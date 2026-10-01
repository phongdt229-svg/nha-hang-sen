import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { storage } from '../storage';
import { GUIDES, type GuideId } from './content';
import { renderGuide, search, taskCount, toc } from './markdown';

/** Trang tương tác chèn vào danh sách hướng dẫn (ví dụ "Chạy thử" theo dõi trực tiếp trên POS). */
export interface GuideExtra {
  id: string;
  title: string;
  render: (go: (target: GuideTarget) => void) => ReactNode;
}

export interface GuideTarget {
  doc: GuideId | string;
  anchor?: string;
}

/**
 * Màn hình hướng dẫn sử dụng toàn trang (HD-03): danh sách hướng dẫn, tìm kiếm không dấu,
 * mục lục, link giữa các hướng dẫn, in trang đang xem. Bài tập "- [ ]" bấm đánh dấu được,
 * tiến độ nhớ theo `progressKey` (tài khoản / thiết bị) trên máy này (HD-10).
 */
export function GuideView({
  docs,
  initial,
  extras = [],
  onClose,
  title = 'Hướng dẫn sử dụng',
  progressKey = 'default',
}: {
  docs: GuideId[];
  initial?: GuideTarget;
  extras?: GuideExtra[];
  onClose: () => void;
  title?: string;
  progressKey?: string;
}) {
  const ids = [...extras.map((e) => e.id), ...docs];
  const [target, setTarget] = useState<GuideTarget>(() =>
    initial && ids.includes(initial.doc) ? initial : { doc: ids[0] ?? docs[0] },
  );
  const [query, setQuery] = useState('');
  const main = useRef<HTMLDivElement>(null);

  const extra = extras.find((e) => e.id === target.doc);
  const guide = extra ? null : GUIDES[target.doc as GuideId];
  const html = useMemo(() => (guide ? renderGuide(guide) : ''), [guide]);
  const hits = useMemo(() => search(query, docs.map((d) => GUIDES[d])), [query, docs]);
  const single = ids.length === 1;
  const tasks = guide ? taskCount(guide) : 0;
  const storeKey = `nhs.guide.progress.${progressKey}`;
  const [progress, setProgress] = useState<Record<string, number[]>>({});
  const doneTasks = guide ? (progress[guide.id] ?? []).filter((i) => i < tasks) : [];

  useEffect(() => {
    try {
      setProgress(JSON.parse(storage.get(storeKey) ?? '{}'));
    } catch {
      setProgress({});
    }
  }, [storeKey]);

  function saveProgress(next: Record<string, number[]>) {
    setProgress(next);
    storage.set(storeKey, JSON.stringify(next));
  }

  // Ô đánh dấu bài tập: marked vẽ ra ô bị khóa → mở khóa và điền theo tiến độ đã lưu.
  useEffect(() => {
    const box = main.current;
    if (!box || !guide) return;
    box.querySelectorAll<HTMLInputElement>('.guide-md input[type="checkbox"]').forEach((input, i) => {
      input.disabled = false;
      input.dataset.task = String(i);
      input.checked = doneTasks.includes(i);
      input.closest('li')?.classList.toggle('guide-task-done', input.checked);
    });
  }, [html, guide, doneTasks]);

  // Ô đánh dấu nằm trong HTML dựng sẵn (không phải phần tử React) nên onChange không tới; bắt qua click.
  function onTaskClick(input: HTMLInputElement) {
    if (!guide || input.dataset.task === undefined) return;
    const i = Number(input.dataset.task);
    const rest = doneTasks.filter((x) => x !== i);
    saveProgress({ ...progress, [guide.id]: input.checked ? [...rest, i] : rest });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Mở hướng dẫn / đổi mục → cuộn tới mục cần xem và nháy sáng để dễ thấy.
  useEffect(() => {
    const box = main.current;
    if (!box || query) return;
    const el = target.anchor ? box.querySelector<HTMLElement>(`[id="${CSS.escape(target.anchor)}"]`) : null;
    if (!el) {
      box.scrollTo({ top: 0 });
      return;
    }
    el.scrollIntoView({ block: 'start' });
    el.classList.add('guide-flash');
    const t = setTimeout(() => el.classList.remove('guide-flash'), 1600);
    return () => clearTimeout(t);
  }, [target, html, query]);

  function go(next: GuideTarget) {
    setQuery('');
    setTarget(next);
  }

  function onArticleClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return onTaskClick(el);
    const a = el.closest('a[data-guide]');
    if (!a) return;
    e.preventDefault();
    const doc = a.getAttribute('data-guide')!;
    if (ids.includes(doc)) go({ doc, anchor: a.getAttribute('data-anchor') ?? undefined });
  }

  const label = (id: string) => extras.find((e) => e.id === id)?.title ?? GUIDES[id as GuideId].title;

  return (
    <div className="guide-overlay fixed inset-0 z-50 flex flex-col bg-stone-50" role="dialog" aria-label={title}>
      <header className="no-print flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-3">
        <h2 className="text-lg font-bold">{title}</h2>
        {!single && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm: giao món, tách bill, hết giấy…"
            aria-label="Tìm trong hướng dẫn"
            className="order-last w-full rounded-xl border border-stone-300 px-3 py-2 sm:order-none sm:w-auto sm:flex-1 sm:max-w-md"
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          {guide && !query && (
            <button className="rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-stone-100" onClick={() => window.print()}>
              In trang này
            </button>
          )}
          <button onClick={onClose} aria-label="Đóng hướng dẫn" className="rounded-lg px-3 py-1 text-2xl leading-none text-stone-500 hover:bg-stone-100">
            ×
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!single && (
          <nav className="no-print hidden w-64 shrink-0 overflow-y-auto border-r border-stone-200 bg-white p-2 md:block" aria-label="Danh sách hướng dẫn">
            {ids.map((id) => (
              <button
                key={id}
                onClick={() => go({ doc: id })}
                className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                  !query && target.doc === id ? 'bg-sen-50 font-semibold text-sen-700' : 'text-stone-700 hover:bg-stone-100'
                }`}
              >
                {label(id)}
                {extras.some((e) => e.id === id) && <span className="rounded-full bg-la-500 px-2 py-0.5 text-[10px] font-bold text-white">TRỰC TIẾP</span>}
              </button>
            ))}
          </nav>
        )}

        <div ref={main} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-4 sm:p-6">
            {!single && (
              <select
                className="no-print mb-4 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 md:hidden"
                value={target.doc}
                onChange={(e) => go({ doc: e.target.value })}
                aria-label="Chọn hướng dẫn"
              >
                {ids.map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
            )}

            {query ? (
              <SearchResults hits={hits} query={query} onOpen={go} />
            ) : extra ? (
              extra.render(go)
            ) : (
              guide && (
                <>
                  {toc(guide).length > 2 && (
                    <div className="no-print mb-4 flex flex-wrap gap-1.5">
                      {toc(guide).map((s) => (
                        <button
                          key={s.anchor}
                          onClick={() => go({ doc: guide.id, anchor: s.anchor })}
                          className="rounded-full bg-white px-3 py-1 text-xs font-medium text-stone-600 ring-1 ring-stone-200 hover:text-sen-700"
                        >
                          {s.heading}
                        </button>
                      ))}
                    </div>
                  )}
                  {tasks > 0 && (
                    <div className="no-print mb-4 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold">
                          Đã làm {doneTasks.length}/{tasks} bài tập
                          {doneTasks.length === tasks && <span className="text-la-600"> · hoàn thành</span>}
                        </span>
                        {doneTasks.length > 0 && (
                          <button
                            className="text-stone-500 underline-offset-2 hover:underline"
                            onClick={() => window.confirm('Bỏ đánh dấu mọi bài tập của trang này?') && saveProgress({ ...progress, [guide.id]: [] })}
                          >
                            Làm lại từ đầu
                          </button>
                        )}
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100">
                        <div className="h-full bg-la-500 transition-all" style={{ width: `${(doneTasks.length / tasks) * 100}%` }} />
                      </div>
                    </div>
                  )}
                  <article
                    className="guide-md rounded-2xl bg-white p-5 ring-1 ring-stone-200 sm:p-7"
                    onClick={onArticleClick}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                </>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchResults({ hits, query, onOpen }: { hits: ReturnType<typeof search>; query: string; onOpen: (t: GuideTarget) => void }) {
  if (hits.length === 0) return <p className="py-8 text-center text-stone-500">Không tìm thấy "{query}". Thử từ khác, ví dụ "robot", "hóa đơn", "máy in".</p>;
  return (
    <ul className="space-y-2">
      {hits.map((h) => (
        <li key={`${h.doc}#${h.anchor ?? ''}`}>
          <button onClick={() => onOpen({ doc: h.doc, anchor: h.anchor })} className="w-full rounded-2xl bg-white p-4 text-left ring-1 ring-stone-200 hover:ring-sen-400">
            <div className="text-xs font-semibold uppercase tracking-wide text-sen-700">{GUIDES[h.doc].title}</div>
            <div className="font-semibold">{h.heading}</div>
            <div className="mt-1 text-sm text-stone-600">{h.snippet}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Nút "Hướng dẫn" đặt ở thanh trên của mỗi màn hình. */
export function HelpButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  return (
    <button
      onClick={onClick}
      title="Hướng dẫn sử dụng"
      aria-label="Hướng dẫn sử dụng"
      className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-stone-600 hover:bg-stone-100"
    >
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-current text-xs leading-none">?</span>
      {!compact && <span className="hidden sm:inline">Hướng dẫn</span>}
    </button>
  );
}
