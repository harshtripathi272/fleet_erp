import type { Request } from 'express';
import { ApiResponse } from '../../core/response/index.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as Files from './files.service.js';

const actor = (req: Request): Files.FileActor => ({ userId: req.auth!.userId, driverId: req.auth!.driverId, can: req.auth!.can });

/** The body is the file itself; its name comes in `X-File-Name` (URI-encoded). */
export const upload = asyncHandler(async (req, res) => {
  const header = req.get('x-file-name');
  let name: string | undefined;
  try { name = header ? decodeURIComponent(header) : undefined; } catch { name = header; }
  // For a company's file field (#97): ?entity=drivers&field=medicalCertificate, or ?master=<custom master id>&field=…
  const q = req.query as { entity?: string; field?: string; master?: string };
  const target = q.field ? { entity: q.master ? 'custom-records' : String(q.entity), field: q.field, masterId: q.master } : undefined;
  ApiResponse.created(res, await Files.upload(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), name, actor(req), target), 'File uploaded');
});

export const download = asyncHandler(async (req, res) => {
  const { file, stream } = await Files.open((req.params as Record<string, string>).id!, actor(req));
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('Content-Disposition', `${req.query.download === '1' || !Files.shownInline(file.mime) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  stream.on('error', (err) => res.destroy(err));
  stream.pipe(res);
});
