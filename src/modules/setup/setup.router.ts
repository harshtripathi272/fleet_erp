import { Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/index.js';
import { ApiResponse } from '../../core/response/index.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as Setup from './setup.service.js';

/**
 * The Company kit (#76): this installation as a company file, a check of a file, and the kit itself.
 * For whoever may change the company. Mounted ahead of the shared JSON parser, with room for logos and
 * spreadsheets (sent base64 inside the JSON).
 */
const router = Router();
const attachmentPath = z.string().regex(/^(files|data)\/[A-Za-z0-9._-]{1,80}$/);
const body = z.strictObject({
  file: z.unknown(),
  // A list, not an object keyed by path: field names with dots are refused (rejectOperators).
  attachments: z.array(z.strictObject({ path: attachmentPath, data: z.string().max(14_000_000) })).max(80).default([]),
});

router.get('/', authorize('company', 'update'), asyncHandler(async (_req, res) => {
  ApiResponse.success(res, { ...(await Setup.fromInstallation()), ...(await Setup.kitOptions()) });
}));
router.post('/check', authorize('company', 'update'), validate({ body: body.extend({ finish: z.enum(['here', 'package']).optional() }) }), asyncHandler(async (req, res) => {
  const input = req.body as Setup.KitRequest & { finish?: Setup.Finish };
  ApiResponse.success(res, Setup.check(input.attachments?.length ? input : { ...input, attachments: await Setup.draftFiles() }));
}));
/** The zip when the file is good; otherwise 422 with each problem and where it is. */
router.post('/kit', authorize('company', 'update'), validate({ body }), asyncHandler(async (req, res) => {
  const result = await Setup.kitFromDraft(req.body as Setup.KitRequest);
  if (!result.zip) throw new ValidationError('The company file has problems', { problems: result.problems.map((p) => `${p.path}: ${p.message}`) });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${result.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(result.zip);
}));

/* The guided set-up (#96). */

router.get('/status', authorize('company', 'read'), asyncHandler(async (_req, res) => ApiResponse.success(res, await Setup.setupStatus())));
router.get('/draft', authorize('company', 'update'), asyncHandler(async (_req, res) => ApiResponse.success(res, await Setup.readDraft())));
const draftBody = z.strictObject({
  file: z.unknown(), step: z.string().max(40).optional(), visited: z.array(z.string().max(40)).max(40).optional(), finish: z.enum(['here', 'package']).optional(), finishedAt: z.string().max(40).optional(),
});
router.put('/draft', authorize('company', 'update'), validate({ body: draftBody }), asyncHandler(async (req, res) => ApiResponse.success(res, await Setup.saveDraft(req.body as Setup.Draft))));
router.delete('/draft', authorize('company', 'update'), asyncHandler(async (_req, res) => { await Setup.discardDraft(); ApiResponse.success(res, { discarded: true }); }));
const attachment = z.strictObject({ path: attachmentPath, data: z.string().max(14_000_000) });
router.put('/draft/file', authorize('company', 'update'), validate({ body: attachment }), asyncHandler(async (req, res) => { await Setup.saveDraftFile(req.body as Setup.Attachment); ApiResponse.success(res, { saved: true }); }));
router.post('/draft/file/remove', authorize('company', 'update'), validate({ body: z.strictObject({ path: attachmentPath }) }), asyncHandler(async (req, res) => { await Setup.removeDraftFile((req.body as { path: string }).path); ApiResponse.success(res, { removed: true }); }));

/**
 * Sets up this copy. It creates accounts and roles, so it needs what those screens need, not only the
 * company's. The answer is one JSON line per finished step, so the screen shows each as it happens.
 */
router.post('/apply', authorize('company', 'update'), authorize('users', 'create'), authorize('roles', 'update'), authorize('connections', 'update'),
  validate({ body: z.strictObject({ file: z.unknown(), clear: z.strictObject({ confirm: z.string().max(200).optional() }).optional() }) }),
  asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const line = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
    try {
      const result = await Setup.applyHere(req.body as { file: unknown; clear?: { confirm?: string } }, { userId: req.auth!.userId }, (r) => line({ type: 'step', ...r }));
      // A demonstration's sign-ins, in this answer only: they're stored nowhere readable.
      line({ type: 'done', applied: result.applied, logins: result.logins });
    } catch (err) {
      // The answer has already begun, so this is told in the stream rather than as a status.
      line({ type: 'error', message: (err as Error).message, details: (err as { details?: unknown }).details });
    }
    res.end();
  }));

export default router;
