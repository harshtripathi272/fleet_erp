import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { fileStore } from '../../core/storage/index.js';
import { DriverDocument } from '../operations/models/cargo.model.js';
import { StoredFile } from './file.model.js';

/** Who is asking: staff with their permissions, or a driver from the driver app. */
export interface FileActor {
  userId: string;
  driverId?: string;
  can: (resource: string, action: 'create' | 'read' | 'update' | 'delete') => boolean;
}

/**
 * The kinds of file accepted, told apart by their first bytes rather than the name or the browser's
 * word for it. Images and PDFs only: nothing a browser would run when it opens the file.
 */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/heic', ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

export const ACCEPTED_TYPES = SIGNATURES.map((s) => s.mime);

const present = (f: { _id: unknown; name: string; mime: string; size: number; at: Date }) => ({ id: String(f._id), name: f.name, mime: f.mime, size: f.size, at: f.at.toISOString() });

/** Staff who file driver documents, and drivers themselves, may upload. */
export async function upload(body: Buffer, rawName: string | undefined, actor: FileActor) {
  if (!actor.driverId && !actor.can('driver-documents', 'create')) throw new ForbiddenError('Your role does not allow uploading documents');
  if (!body.length) throw new ValidationError('The file is empty');
  const kind = SIGNATURES.find((s) => s.test(body));
  if (!kind) throw new ValidationError('Send a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  const name = (rawName ?? '').replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 200) || `document.${kind.ext}`;
  const at = new Date();
  const key = `${at.toISOString().slice(0, 7)}/${randomUUID()}.${kind.ext}`;
  await (await fileStore()).put(key, body, kind.mime);
  const file = await StoredFile.create({
    name, mime: kind.mime, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), key,
    uploadedBy: actor.userId, driverId: actor.driverId, at,
  });
  return present(file);
}

/** Staff who read driver documents see every file; others only what they uploaded, and a driver also what was filed for them. */
export async function open(id: string, actor: FileActor): Promise<{ file: ReturnType<typeof present>; stream: Readable }> {
  const file = await StoredFile.findById(id).lean();
  if (!file) throw new NotFoundError('File not found');
  const own = String(file.uploadedBy) === actor.userId;
  const forDriver = actor.driverId ? Boolean(await DriverDocument.exists({ driverId: actor.driverId, 'file.fileId': file._id })) : false;
  if (!own && !forDriver && (actor.driverId || !actor.can('driver-documents', 'read'))) throw new NotFoundError('File not found');
  return { file: present(file), stream: await (await fileStore()).open(file.key) };
}

/** A file named in a record must exist and be one the person filing it may use. */
export async function attachable(id: string, actor: FileActor) {
  const file = await StoredFile.findById(id).lean();
  if (!file) throw new ValidationError('The attached file was not found');
  if (String(file.uploadedBy) !== actor.userId && (actor.driverId || !actor.can('driver-documents', 'read'))) throw new ValidationError('The attached file was not found');
  return present(file);
}
