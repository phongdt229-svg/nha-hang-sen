import type { NextFunction, Request, Response } from 'express';
import { metrics } from './metrics';

/** Đo thời gian mọi request theo mẫu đường dẫn (/bills/:id/lock), không theo id cụ thể. */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = (req.route?.path as string | undefined) ?? 'unmatched';
    if (route === '/metrics') return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    metrics.httpDuration.observe(seconds, labels);
    if (res.statusCode >= 500) metrics.httpErrors.inc({ method: req.method, route });
  });
  next();
}
