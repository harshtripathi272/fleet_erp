import type { ErrorRequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError, BadRequestError, ConflictError, InternalServerError, ServiceUnavailableError, ValidationError } from '../core/errors/index.js';
import { duplicateKeyError } from '../core/masters/service.js';
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
  } else if (!(err instanceof AppError)) {
    error = fromDatabaseError(err) ?? error;
  }
  if (error.isOperational) logger.warn({ requestId: req.requestId, code: error.code, statusCode: error.statusCode }, 'Request rejected');
  else logger.error({ err, requestId: req.requestId }, 'Unexpected request failure');
  const hideDetails = env.NODE_ENV === 'production' && !error.isOperational;
  ApiResponse.error(res, error.statusCode, error.code,
    hideDetails ? 'Internal server error' : error.message,
    req.requestId, hideDetails ? undefined : error.details);
};

/** Maps MongoDB / Mongoose failures that slip past request validation to client errors. */
function fromDatabaseError(err: unknown): AppError | null {
  if (!err || typeof err !== 'object') return null;
  const name = (err as { name?: string }).name;
  const dup = duplicateKeyError(err);
  if (dup) return dup;
  if (name === 'CastError') return new BadRequestError('A value has the wrong type', { path: (err as { path?: string }).path });
  if (name === 'StrictModeError') return new BadRequestError('Unknown field in request');
  if (name === 'VersionError') return new ConflictError('This record was changed by someone else. Reload it and try again.');
  if (name === 'ValidationError' && 'errors' in err) {
    const details = Object.fromEntries(Object.entries((err as { errors: Record<string, { message: string }> }).errors).map(([k, v]) => [k, [v.message]]));
    return new ValidationError('Validation failed', { fields: details });
  }
  if (name === 'MongoServerSelectionError' || name === 'MongoNetworkError' || name === 'MongooseServerSelectionError') {
    return new ServiceUnavailableError('Database unavailable, try again shortly');
  }
  return null;
}
