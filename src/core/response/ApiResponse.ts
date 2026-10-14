import type { Response } from 'express';
import { BadRequestError } from '../errors/index.js';
import { HTTP_STATUS } from '../../utils/constants.js';

export function buildPaginationMeta(total: number, page: number, limit: number) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new BadRequestError('Invalid pagination values');
  }
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 };
}

type Message = string | { message?: string };
const messageFields = (options?: Message) => typeof options === 'string' ? { message: options } : (options ?? {});

export class ApiResponse {
  static success<T extends NonNullable<unknown>>(res: Response, data: T, options?: Message): void {
    res.status(HTTP_STATUS.OK).json({ success: true, data: data ?? {}, ...messageFields(options) });
  }
  static created<T extends NonNullable<unknown>>(res: Response, data: T, message?: string): void {
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: data ?? {}, ...messageFields(message) });
  }
  static noContent(res: Response): void {
    res.status(HTTP_STATUS.NO_CONTENT).end();
  }
  static paginated<T>(res: Response, data: T[], meta: ReturnType<typeof buildPaginationMeta>): void {
    res.status(HTTP_STATUS.OK).json({ success: true, data, meta });
  }
  static error(res: Response, status: number, code: string, message: string, requestId: string, details?: unknown): void {
    res.status(status).json({ success: false, error: { code, message, ...(details === undefined ? {} : { details }) }, requestId });
  }
}
