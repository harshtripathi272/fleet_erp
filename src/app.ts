import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { authenticate } from './middleware/authenticate.js';
import { compressJson } from './middleware/compressJson.js';
import { cors } from './middleware/cors.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { precompressed } from './middleware/precompressed.js';
import { rejectOperators } from './middleware/rejectOperators.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import auditRouter from './modules/audit/audit.router.js';
import authRouter from './modules/auth/auth.router.js';
import cargoRouter from './modules/cargo/cargo.router.js';
import companyRouter from './modules/company/company.router.js';
import filesRouter from './modules/files/files.router.js';
import maintenanceRouter from './modules/maintenance/maintenance.router.js';
import complianceRouter from './modules/compliance/compliance.router.js';
import configurationRouter from './modules/configuration/configuration.router.js';
import driversRouter from './modules/drivers/drivers.router.js';
import financeRouter from './modules/finance/finance.router.js';
import fleetRouter from './modules/fleet/fleet.router.js';
import geographyRouter from './modules/geography/geography.router.js';
import healthRouter from './modules/health/health.router.js';
import messagingRouter from './modules/messaging/messaging.router.js';
import metaRouter, { publicMetaRouter } from './modules/meta/meta.router.js';
import operationsRouter, { webhookRouter } from './modules/operations/operations.router.js';
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
app.use('/api', compressJson);
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
app.use('/api/v1/files', authenticate, filesRouter);
app.use('/api/v1/whatsapp', webhookRouter);
// Trips and money; signs in only its own paths, so it adds nothing to master requests.
app.use('/api/v1', operationsRouter);
// Masters, grouped by area (MF-SPEC-01 section 8). Every route below requires a signed-in user.
app.use('/api/v1', authenticate, organisationRouter);
app.use('/api/v1', authenticate, geographyRouter);
app.use('/api/v1', authenticate, financeRouter);
app.use('/api/v1', authenticate, partiesRouter);
app.use('/api/v1', authenticate, fleetRouter);
app.use('/api/v1', authenticate, maintenanceRouter);
app.use('/api/v1', authenticate, driversRouter);
app.use('/api/v1', authenticate, complianceRouter);
app.use('/api/v1', authenticate, cargoRouter);
app.use('/api/v1', authenticate, tripsRouter);
app.use('/api/v1', authenticate, messagingRouter);
app.use('/api/v1', authenticate, configurationRouter);

// The web app (web/dist), when built: hashed assets cached for a year, the page itself never,
// and any other GET outside the API answered with the page so the app's own routes work.
// "Never" is no-cache: the browser asks every time (a 304 when unchanged), so a deploy is picked up at once.
const webDir = env.WEB_DIR ?? fileURLToPath(new URL('../web/dist', import.meta.url));
if (existsSync(join(webDir, 'index.html'))) {
  // Compressed when the browser accepts it. A file from an older build is a plain 404 (the app reloads
  // itself when that happens; see web/src/App.tsx).
  const assets = { immutable: true, maxAge: '1y' };
  app.use('/assets', precompressed(join(webDir, 'assets'), assets), express.static(join(webDir, 'assets'), assets), notFound);
  app.use(
    express.static(webDir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get(/^\/(?!api\/|api$|console(\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(webDir, 'index.html'));
  });
}

app.use(notFound);
app.use(errorHandler);
