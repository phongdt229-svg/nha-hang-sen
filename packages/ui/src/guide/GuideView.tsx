import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { GUIDES, type GuideId } from './content';
import { renderGuide, search, toc } from './markdown';

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
 * mục lục, link giữa các hướng dẫn, in trang đang xem.
 */
export function GuideView({
  docs,
  initial,
  extras = [],
  onClose,
  title = 'Hướng dẫn sử dụng',
}: {
  docs: GuideId[];
  initial?: GuideTarget;
  extras?: GuideExtra[];
  onClose: () => void;
  title?: string;
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
    const a = (e.target as HTMLElement).closest('a[data-guide]');
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
                  <article className="guide-md rounded-2xl bg-white p-5 ring-1 ring-stone-200 sm:p-7" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: html }} />
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
