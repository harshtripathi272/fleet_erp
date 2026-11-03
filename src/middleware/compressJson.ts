import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { RequestHandler } from 'express';

/** Smaller answers aren't worth the work: the headers alone are about this size. */
const MIN_BYTES = 1024;

/**
 * Compresses JSON answers for browsers that accept it, brotli first. An office desk's first load is about
 * 300 kB of JSON (the masters and /operations/sync), several seconds on a slow mobile network uncompressed
 * and a tenth of that compressed. Brotli at quality 5 takes a few milliseconds for that much. Files, streams
 * and anything not JSON are left alone.
 */
export const compressJson: RequestHandler = (req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body?: unknown) => {
    const json = String(res.getHeader('Content-Type') ?? '').includes('json');
    if (!json || res.getHeader('Content-Encoding') || !(typeof body === 'string' || Buffer.isBuffer(body))) return send(body);
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (raw.length < MIN_BYTES) return send(body);
    res.vary('Accept-Encoding');
    if (req.acceptsEncodings('br')) {
      res.setHeader('Content-Encoding', 'br');
      return send(brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }));
    }
    if (req.acceptsEncodings('gzip')) {
      res.setHeader('Content-Encoding', 'gzip');
      return send(gzipSync(raw));
    }
    return send(body);
  };
  next();
};
