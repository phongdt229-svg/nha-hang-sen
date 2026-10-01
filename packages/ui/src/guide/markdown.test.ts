import { describe, expect, it } from 'vitest';
import { GUIDES } from './content';
import { fold, headingAnchors, resolveLink, search, slugify, taskCount } from './markdown';

describe('hướng dẫn sử dụng', () => {
  it('id tiêu đề giống GitHub để link trong docs dùng được trong app', () => {
    expect(slugify('4. Robot giao món gặp sự cố')).toBe('4-robot-giao-món-gặp-sự-cố');
    expect(slugify('Tách bill (mỗi người trả phần mình)')).toBe('tách-bill-mỗi-người-trả-phần-mình');
  });

  it('tìm không dấu', () => {
    expect(fold('Đã giao món')).toBe('da giao mon');
    const hits = search('giao mon robot', [GUIDES['phuc-vu']]);
    expect(hits[0]).toMatchObject({ doc: 'phuc-vu', heading: 'Giao món', anchor: 'giao-món' });
    expect(search('không có từ này xyz', Object.values(GUIDES))).toEqual([]);
    expect(search('het giay', Object.values(GUIDES))[0].snippet).toContain('ết giấy');
  });

  it('link tương đối giữa các file → hướng dẫn trong app', () => {
    expect(resolveLink('../van-hanh/runbook.md#4-robot-giao-món-gặp-sự-cố', GUIDES['phuc-vu'])).toEqual({
      doc: 'runbook',
      anchor: '4-robot-giao-món-gặp-sự-cố',
    });
    expect(resolveLink('https://example.com', GUIDES.bep)).toBe('external');
    expect(resolveLink('../../infra/backup/README.md', GUIDES.runbook)).toBeNull();
  });

  it('đào tạo: đủ bài tập theo vai trò và câu hỏi kiểm tra có đáp án', () => {
    const g = GUIDES['dao-tao'];
    expect(taskCount(g)).toBeGreaterThanOrEqual(25);
    expect(taskCount(GUIDES['phuc-vu'])).toBe(0);
    expect(g.markdown.match(/^\*\*\d+\. /gm)).toHaveLength(10);
    expect(g.markdown.match(/<summary>Đáp án<\/summary>/g)).toHaveLength(10);
    // Câu hỏi và đáp án không lọt vào kết quả tìm kiếm dưới dạng thẻ HTML.
    expect(search('dap an', [g]).every((h) => !h.snippet.includes('<'))).toBe(true);
  });

  // Đổi tên tiêu đề trong docs mà quên sửa link → test đỏ, không để link chết trong app.
  it('mọi link sang hướng dẫn khác trỏ tới tiêu đề có thật', () => {
    for (const g of Object.values(GUIDES)) {
      for (const [, href] of g.markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
        const t = resolveLink(href, g);
        if (!t || t === 'external' || !t.anchor) continue;
        expect(headingAnchors(GUIDES[t.doc]), `${g.path} → ${href}`).toContain(t.anchor);
      }
    }
  });
});
