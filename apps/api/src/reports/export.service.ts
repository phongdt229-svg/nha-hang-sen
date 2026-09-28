import { Injectable, NotImplementedException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { ReportTable } from './table';

export type ExportFormat = 'xlsx' | 'csv' | 'pdf';

const money = new Intl.NumberFormat('vi-VN');

function cell(v: unknown, kind?: string): string {
  if (v === null || v === undefined) return '';
  if (kind === 'money' && typeof v === 'number') return money.format(v);
  if (kind === 'percent' && typeof v === 'number') return `${(v * 100).toFixed(1)}%`;
  return String(v);
}

/** Xuất báo cáo cho kế toán: Excel (ExcelJS), CSV, PDF (in trang HTML bằng Chrome). */
@Injectable()
export class ExportService {
  async render(tables: ReportTable[], format: ExportFormat, meta: string): Promise<{ body: Buffer; contentType: string; ext: string }> {
    if (format === 'xlsx') return { body: await this.xlsx(tables, meta), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    if (format === 'csv') return { body: Buffer.from('﻿' + this.csv(tables), 'utf8'), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
    return { body: await this.pdf(tables, meta), contentType: 'application/pdf', ext: 'pdf' };
  }

  async xlsx(tables: ReportTable[], meta: string) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Nhà hàng Sen';
    for (const t of tables) {
      const ws = wb.addWorksheet(t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
      ws.addRow([t.title]).font = { bold: true, size: 14 };
      ws.addRow([meta]).font = { italic: true, color: { argb: 'FF666666' } };
      ws.addRow([]);
      const header = ws.addRow(t.columns.map((c) => c.label || 'Mục'));
      header.font = { bold: true };
      header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE7EF' } }));
      for (const r of t.rows) ws.addRow(t.columns.map((c) => r[c.key] ?? null));
      if (t.totals) {
        const total = ws.addRow(t.columns.map((c, i) => (i === 0 ? 'Tổng' : (t.totals![c.key] ?? null))));
        total.font = { bold: true };
      }
      t.columns.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = i === 0 ? 32 : 18;
        if (c.kind === 'money') col.numFmt = '#,##0';
        if (c.kind === 'percent') col.numFmt = '0.0%';
      });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  csv(tables: ReportTable[]) {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return tables
      .map((t) => [t.columns.map((c) => esc(c.label || 'Mục')).join(','), ...t.rows.map((r) => t.columns.map((c) => esc(r[c.key])).join(','))].join('\n'))
      .join('\n\n');
  }

  html(tables: ReportTable[], meta: string) {
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const body = tables
      .map(
        (t) => `<h2>${esc(t.title)}</h2><table><thead><tr>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${t.rows
          .map((r) => `<tr>${t.columns.map((c) => `<td class="${c.kind ?? ''}">${esc(cell(r[c.key], c.kind))}</td>`).join('')}</tr>`)
          .join('')}${
          t.totals ? `<tr class="total">${t.columns.map((c, i) => `<td class="${c.kind ?? ''}">${i === 0 ? 'Tổng' : esc(cell(t.totals![c.key], c.kind))}</td>`).join('')}</tr>` : ''
        }</tbody></table>`,
      )
      .join('');
    return `<!doctype html><html lang="vi"><meta charset="utf-8"><style>
      body{font-family:'Be Vietnam Pro',Arial,sans-serif;font-size:11px;color:#222;margin:24px}
      h1{font-size:18px;margin:0}p{color:#666}h2{font-size:14px;margin-top:20px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left}
      th{background:#fce7ef}td.money,td.number,td.percent{text-align:right}tr.total td{font-weight:bold}
    </style><h1>Nhà hàng Sen</h1><p>${esc(meta)}</p>${body}</html>`;
  }

  async pdf(tables: ReportTable[], meta: string) {
    const executablePath = process.env.CHROME_PATH;
    if (!executablePath) throw new NotImplementedException('Chưa cấu hình CHROME_PATH để xuất PDF; dùng xlsx hoặc csv');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(this.html(tables, meta), { waitUntil: 'load' });
      return Buffer.from(await page.pdf({ format: 'A4', margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } }));
    } finally {
      await browser.close();
    }
  }
}
