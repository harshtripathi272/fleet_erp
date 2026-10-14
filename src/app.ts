import express from 'express';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './modules/health/health.router.js';

export const app = express();
app.disable('x-powered-by');
app.use(requestId);
app.use(requestLogger);
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/health', healthRouter);
app.use(notFound);
app.use(errorHandler);
