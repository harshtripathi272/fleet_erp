import type { RequestHandler } from 'express';
import { logger } from '../core/logger/index.js';

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = performance.now();
  const path = req.path;
  res.once('close', () => {
    logger.info({
      requestId: req.requestId, method: req.method, path,
      statusCode: res.statusCode, durationMs: Math.round((performance.now() - start) * 100) / 100,
      aborted: !res.writableFinished,
    }, 'Request completed');
  });
  next();
};
