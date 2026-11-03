import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { RequestHandler } from 'express';

/** Preferred first: brotli is about a fifth smaller than gzip for scripts. */
const ENCODINGS = [
  ['br', '.br'],
  ['gzip', '.gz'],
] as const;

/**
 * Serves the web build's compressed copies (the `.br` and `.gz` files `web/vite.config.ts` writes beside each
 * script and stylesheet) to browsers that accept them; anything else falls through to the plain file. On a
 * phone over a slow mobile network this is most of the download: the sign-in screen's script is about a third
 * of its size compressed. The folder is listed once, since a build never changes while the server runs.
 */
export function precompressed(dir: string, options: { maxAge: string; immutable: boolean }): RequestHandler {
  const files = new Set(existsSync(dir) ? readdirSync(dir) : []);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path.slice(1);
    if (!files.has(name)) return next();
    res.vary('Accept-Encoding');
    for (const [encoding, suffix] of ENCODINGS) {
      if (!files.has(name + suffix) || !req.acceptsEncodings(encoding)) continue;
      res.setHeader('Content-Encoding', encoding);
      res.type(extname(name));
      return res.sendFile(join(dir, name + suffix), { ...options, acceptRanges: false });
    }
    next();
  };
}
