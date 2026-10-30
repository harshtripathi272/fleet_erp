import { AppError } from './AppError.js';
import { ERROR_CODES, HTTP_STATUS } from '../../utils/constants.js';

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.BAD_REQUEST, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details?: unknown) {
    super(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, details);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Access denied', details?: unknown) {
    super(message, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN, details);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super(message, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND, details);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', details?: unknown) {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.CONFLICT, details);
  }
}
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, HTTP_STATUS.VALIDATION_ERROR, ERROR_CODES.VALIDATION_ERROR, details);
  }
}
export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', details?: unknown) {
    super(message, HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_CODES.TOO_MANY_REQUESTS, details);
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', details?: unknown) {
    super(message, HTTP_STATUS.SERVICE_UNAVAILABLE, ERROR_CODES.SERVICE_UNAVAILABLE, details);
  }
}
export class InternalServerError extends AppError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_SERVER_ERROR, undefined, false, cause);
  }
}
