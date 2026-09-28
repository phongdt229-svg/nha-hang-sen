import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MissingTaxRateError } from '@nhs/pricing';
import { InvalidTransitionError } from '@nhs/types';
import type { Response } from 'express';

/** Định dạng lỗi thống nhất: { statusCode, error, message }. */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : exception);
    res.status(status).json({ statusCode: status, ...body });
  }

  private map(e: unknown): [number, Record<string, unknown>] {
    if (e instanceof HttpException) {
      const r = e.getResponse();
      return [e.getStatus(), typeof r === 'string' ? { message: r } : (r as Record<string, unknown>)];
    }
    if (e instanceof InvalidTransitionError) return [HttpStatus.CONFLICT, { error: 'INVALID_TRANSITION', message: e.message }];
    if (e instanceof MissingTaxRateError) return [HttpStatus.UNPROCESSABLE_ENTITY, { error: 'MISSING_TAX_RATE', message: e.message }];
    if (e instanceof RangeError) return [HttpStatus.BAD_REQUEST, { error: 'BAD_REQUEST', message: e.message }];
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return [HttpStatus.NOT_FOUND, { error: 'NOT_FOUND', message: 'Không tìm thấy dữ liệu' }];
    }
    return [HttpStatus.INTERNAL_SERVER_ERROR, { error: 'INTERNAL', message: 'Lỗi hệ thống' }];
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
