import type { RequestHandler } from 'express';

const API_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** The web app also loads map styles and tiles, and runs the map's worker. */
const MAP_HOST = 'https://tiles.openfreemap.org';
const WEB_POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data: blob: ${MAP_HOST}; connect-src 'self' ${MAP_HOST}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

/** Conservative response headers for the API, the test console and the web app. */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  const api = req.path.startsWith('/api/') || req.path.startsWith('/console');
  res.setHeader('Content-Security-Policy', api ? API_POLICY : WEB_POLICY);
  next();
};
