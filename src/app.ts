import express from 'express';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { authenticate } from './middleware/authenticate.js';
import { cors } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { rejectOperators } from './middleware/rejectOperators.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import auditRouter from './modules/audit/audit.router.js';
import authRouter from './modules/auth/auth.router.js';
import cargoRouter from './modules/cargo/cargo.router.js';
import companyRouter from './modules/company/company.router.js';
import complianceRouter from './modules/compliance/compliance.router.js';
import configurationRouter from './modules/configuration/configuration.router.js';
import driversRouter from './modules/drivers/drivers.router.js';
import financeRouter from './modules/finance/finance.router.js';
import fleetRouter from './modules/fleet/fleet.router.js';
import geographyRouter from './modules/geography/geography.router.js';
import healthRouter from './modules/health/health.router.js';
import messagingRouter from './modules/messaging/messaging.router.js';
import metaRouter, { publicMetaRouter } from './modules/meta/meta.router.js';
import organisationRouter from './modules/organisation/organisation.router.js';
import partiesRouter from './modules/parties/parties.router.js';
import rolesRouter from './modules/roles/roles.router.js';
import tripsRouter from './modules/trips/trips.router.js';
import usersRouter from './modules/users/users.router.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY);
app.use(securityHeaders);
app.use(cors);
app.use(requestId);
app.use(requestLogger);
app.use(express.json({ limit: '1mb' }));
app.use(rejectOperators);

if (env.CONSOLE_ENABLED) {
  app.use('/console', express.static(fileURLToPath(new URL('../public/console', import.meta.url)), { index: 'index.html', maxAge: 0 }));
  app.use('/api/v1/meta', publicMetaRouter);
}

app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/meta', authenticate, metaRouter);
app.use('/api/v1/company', authenticate, companyRouter);
app.use('/api/v1/audit-logs', authenticate, auditRouter);
app.use('/api/v1/users', authenticate, usersRouter);
app.use('/api/v1/roles', authenticate, rolesRouter);
// Masters, grouped by area (MF-SPEC-01 section 8). Every route below requires a signed-in user.
app.use('/api/v1', authenticate, organisationRouter);
app.use('/api/v1', authenticate, geographyRouter);
app.use('/api/v1', authenticate, financeRouter);
app.use('/api/v1', authenticate, partiesRouter);
app.use('/api/v1', authenticate, fleetRouter);
app.use('/api/v1', authenticate, driversRouter);
app.use('/api/v1', authenticate, complianceRouter);
app.use('/api/v1', authenticate, cargoRouter);
app.use('/api/v1', authenticate, tripsRouter);
app.use('/api/v1', authenticate, messagingRouter);
app.use('/api/v1', authenticate, configurationRouter);

app.use(notFound);
app.use(errorHandler);
