import { Injectable, Logger } from '@nestjs/common';

/**
 * Gửi thông báo cho chủ/quản lý (báo cáo cuối ngày, cảnh báo kho, sự cố).
 * Hỗ trợ Telegram bot hoặc một webhook bất kỳ (Zalo OA, Slack…); chưa cấu hình thì chỉ ghi log.
 */
@Injectable()
export class Notifier {
  private readonly logger = new Logger('Notifier');

  async send(title: string, text: string) {
    const body = `${title}\n${text}`;
    const tasks: Promise<unknown>[] = [];
    const { TELEGRAM_BOT_TOKEN: bot, TELEGRAM_CHAT_ID: chat, NOTIFY_WEBHOOK_URL: hook } = process.env;
    if (bot && chat) {
      tasks.push(
        fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: body }),
        }),
      );
    }
    if (hook) tasks.push(fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text }) }));
    if (tasks.length === 0) {
      this.logger.log(body);
      return;
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') this.logger.warn(`Gửi thông báo lỗi: ${r.reason}`);
  }
}
