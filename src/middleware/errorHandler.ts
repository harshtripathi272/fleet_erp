import type { ErrorRequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError, BadRequestError, InternalServerError } from '../core/errors/index.js';
import { logger } from '../core/logger/index.js';
import { ApiResponse } from '../core/response/index.js';
import { ERROR_CODES, HTTP_STATUS } from '../utils/constants.js';

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) { next(err); return; }
  let error = err instanceof AppError ? err : new InternalServerError('Internal server error', err);
  if (err instanceof SyntaxError && 'type' in err && err.type === 'entity.parse.failed') {
    error = new BadRequestError('Malformed JSON body');
  } else if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
    error = new AppError('Request body too large', HTTP_STATUS.PAYLOAD_TOO_LARGE, ERROR_CODES.PAYLOAD_TOO_LARGE);
  }
  if (error.isOperational) logger.warn({ requestId: req.requestId, code: error.code, statusCode: error.statusCode }, 'Request rejected');
  else logger.error({ err, requestId: req.requestId }, 'Unexpected request failure');
  const hideDetails = env.NODE_ENV === 'production' && !error.isOperational;
  ApiResponse.error(res, error.statusCode, error.code,
    hideDetails ? 'Internal server error' : error.message,
    req.requestId, hideDetails ? undefined : error.details);
};
