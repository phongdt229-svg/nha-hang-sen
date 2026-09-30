import { marked } from 'marked';
import { GUIDES, type GuideDoc, type GuideId } from './content';

/** Id của tiêu đề giống GitHub, để link "#4-robot-giao-món-gặp-sự-cố" trong docs vẫn đúng trong app. */
export function slugify(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** Bỏ dấu tiếng Việt để tìm "giao mon" ra "Giao món". */
export function fold(text: string) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/** Link tương đối trong file .md → hướng dẫn khác trong app (nếu có), kèm mục cần cuộn tới. */
export function resolveLink(href: string, from: GuideDoc): { doc: GuideId; anchor?: string } | 'external' | null {
  if (/^https?:/i.test(href)) return 'external';
  if (href.startsWith('#')) return { doc: from.id, anchor: decodeURIComponent(href.slice(1)) || undefined };
  const url = new URL(href, `http://docs/${from.path}`);
  const target = Object.values(GUIDES).find((g) => `/${g.path}` === decodeURIComponent(url.pathname));
  if (!target) return null;
  return { doc: target.id, anchor: url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined };
}

const plain = (md: string) =>
  md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface GuideSection {
  doc: GuideId;
  heading: string;
  anchor?: string;
  text: string;
}

/** Chia hướng dẫn theo mục "##" để tìm kiếm trả về đúng mục. */
export function sections(g: GuideDoc): GuideSection[] {
  const out: GuideSection[] = [];
  let cur: GuideSection = { doc: g.id, heading: g.title, text: '' };
  for (const line of g.markdown.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h && h[1].length === 2) {
      out.push(cur);
      cur = { doc: g.id, heading: plain(h[2]), anchor: slugify(plain(h[2])), text: '' };
    } else if (!(h && h[1].length === 1)) {
      cur.text += `${line}\n`;
    }
  }
  out.push(cur);
  return out.filter((s) => s.anchor || plain(s.text));
}

export interface SearchHit extends GuideSection {
  snippet: string;
}

export function search(query: string, docs: GuideDoc[]): SearchHit[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const g of docs) {
    for (const s of sections(g)) {
      const body = plain(s.text);
      const hay = fold(`${g.title} ${s.heading} ${body}`);
      if (!terms.every((t) => hay.includes(t))) continue;
      const at = Math.max(0, fold(body).indexOf(terms[0]));
      const from = Math.max(0, at - 40);
      hits.push({ ...s, snippet: `${from > 0 ? '…' : ''}${body.slice(from, from + 140)}${body.length > from + 140 ? '…' : ''}` });
    }
  }
  return hits;
}

/** Các mục "##" để làm mục lục đầu trang. */
export function toc(g: GuideDoc) {
  return sections(g)
    .filter((s) => s.anchor)
    .map((s) => ({ heading: s.heading, anchor: s.anchor! }));
}

/**
 * Markdown → HTML: tiêu đề có id, link sang hướng dẫn khác thành link trong app (data-guide),
 * link tới file không có trong app thành chữ thường. Nội dung là file docs/ của chính dự án.
 */
export function renderGuide(g: GuideDoc): string {
  const html = marked.parse(g.markdown, { async: false, gfm: true });
  const dom = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  dom.querySelectorAll('h1, h2, h3, h4').forEach((h) => (h.id = slugify(h.textContent ?? '')));
  dom.querySelectorAll('a[href]').forEach((a) => {
    const target = resolveLink(a.getAttribute('href')!, g);
    if (target === 'external') {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else if (target) {
      a.setAttribute('href', '#');
      a.setAttribute('data-guide', target.doc);
      if (target.anchor) a.setAttribute('data-anchor', target.anchor);
    } else {
      const span = dom.createElement('span');
      span.innerHTML = a.innerHTML;
      a.replaceWith(span);
    }
  });
  dom.querySelectorAll('table').forEach((t) => {
    const wrap = dom.createElement('div');
    wrap.className = 'guide-table';
    t.replaceWith(wrap);
    wrap.append(t);
  });
  return dom.body.firstElementChild!.innerHTML;
}
