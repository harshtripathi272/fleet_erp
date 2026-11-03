import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

const API_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** The web app also loads map styles and tiles, and runs the map's worker. */
const MAP_HOST = 'https://tiles.openfreemap.org';
const WEB_POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data: blob: ${MAP_HOST}; connect-src 'self' ${MAP_HOST}; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
/** Nothing here uses the camera, microphone or payments from script; location only from this site (the driver app). */
const PERMISSIONS = 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)';

/** Conservative response headers for the API, the test console and the web app. */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS);
  // Production runs behind https (APP_URL must be https://); browsers ignore this header over plain http.
  if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const api = req.path.startsWith('/api/');
  // API answers carry company data: never kept by the browser or a shared cache. Routes that serve files set their own.
  if (api) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', api || req.path.startsWith('/console') ? API_POLICY : WEB_POLICY);
  next();
};
