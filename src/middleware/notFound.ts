import type { RequestHandler } from 'express';
import { NotFoundError } from '../core/errors/index.js';

export const notFound: RequestHandler = (_req, _res, next) => next(new NotFoundError('Route not found'));
