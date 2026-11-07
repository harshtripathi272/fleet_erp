import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Types } from 'mongoose';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/index.js';
import { acceptedKinds, isFileType, KIND_MIMES, megabytes, mimesFor, refusedKind, setFileHooks, type FileActor, type FileOptions } from '../../core/masters/fileFields.js';
import { storeForNew, storeOf } from '../../core/storage/index.js';
import { CustomMaster, FieldDefinition } from '../configuration/models/configuration.model.js';
import { Consignment, DriverDocument } from '../operations/models/cargo.model.js';
import { Trip } from '../operations/models/trip.model.js';
import { StoredFile, type StoredFileRecord } from './file.model.js';

/** Who is asking: staff with their permissions, or a driver from the driver app. */
export type { FileActor };

/**
 * The kinds of file accepted, told apart by their first bytes rather than the name or the browser's word for
 * it. Images and PDFs by default; Word and Excel only for a field the company widened to take them (#97).
 * Nothing a browser would run when it opens the file: no HTML, SVG or scripts, whatever the name says.
 */
const zipHas = (b: Buffer, folder: string) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && b.includes(Buffer.from(folder, 'latin1'));
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const oleHas = (b: Buffer, name: string) => b.subarray(0, 8).equals(OLE) && b.includes(Buffer.from(name, 'utf16le'));
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/heic', ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: KIND_MIMES.word[0]!, ext: 'docx', test: (b) => zipHas(b, 'word/') },
  { mime: KIND_MIMES.excel[0]!, ext: 'xlsx', test: (b) => zipHas(b, 'xl/') },
  { mime: KIND_MIMES.word[1]!, ext: 'doc', test: (b) => oleHas(b, 'WordDocument') },
  { mime: KIND_MIMES.excel[1]!, ext: 'xls', test: (b) => oleHas(b, 'Workbook') || oleHas(b, 'Book') },
];

/** What an upload with no field named may be: a photo or a PDF, as before. */
export const ACCEPTED_TYPES = [...KIND_MIMES.images, ...KIND_MIMES.pdf];
/** Opened in the browser's own viewer; anything else (Word, Excel) is always downloaded. */
export const shownInline = (mime: string) => ACCEPTED_TYPES.includes(mime);

const present = (f: { _id: unknown; name: string; mime: string; size: number; at: Date }) => ({ id: String(f._id), name: f.name, mime: f.mime, size: f.size, at: f.at.toISOString() });

/** The company field a file is uploaded for (#97): a field of a master or record, or of a custom master's records. */
export interface UploadTarget { entity: string; field: string; masterId?: string }

/** The field's definition, and the permission that changing a record with it needs. */
async function targetField(target: UploadTarget): Promise<{ field: FileOptions & { askedOf?: string }; resource: string }> {
  if (target.masterId) {
    const master = await CustomMaster.findOne({ _id: target.masterId, status: 'active' }).lean();
    const field = (master?.fields as unknown as Array<FileOptions & { key: string }> | undefined)?.find((f) => f.key === target.field);
    if (!field || !isFileType(field.type)) throw new ValidationError(`No file field "${target.field}" on this master`);
    return { field, resource: 'custom-records' };
  }
  const field = await FieldDefinition.findOne({ entity: target.entity, key: target.field, status: 'active' }).lean() as unknown as (FileOptions & { askedOf?: string }) | null;
  if (!field || !isFileType(field.type)) throw new ValidationError(`No file field "${target.field}" on ${target.entity}`);
  return { field, resource: target.entity };
}

/**
 * Staff who file driver documents, and drivers themselves, may upload. For a company's file field (#97), whoever
 * may add or change that master's records may, and the field's kinds and size apply. The bytes decide the kind.
 */
export async function upload(body: Buffer, rawName: string | undefined, actor: FileActor, target?: UploadTarget) {
  let field: (FileOptions & { askedOf?: string }) | undefined;
  if (target) {
    const found = await targetField(target);
    field = found.field;
    const allowed = actor.driverId ? field.askedOf === 'driver' : actor.can(found.resource, 'create') || actor.can(found.resource, 'update');
    if (!allowed) throw new ForbiddenError('Your role does not allow adding files here');
  } else if (!actor.driverId && !actor.can('driver-documents', 'create')) throw new ForbiddenError('Your role does not allow uploading documents');
  if (!body.length) throw new ValidationError('The file is empty');
  const kind = SIGNATURES.find((s) => s.test(body));
  if (field) {
    if (!kind || !mimesFor(field).includes(kind.mime)) throw new ValidationError(refusedKind(kind?.mime, acceptedKinds(field)));
    if (field.maxSizeMb && body.length > field.maxSizeMb * 1048576) throw new ValidationError(`That file is ${megabytes(body.length)}; this field takes files up to ${field.maxSizeMb} MB.`);
  } else if (!kind || !ACCEPTED_TYPES.includes(kind.mime)) throw new ValidationError('Send a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  const name = (rawName ?? '').replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 200) || `document.${kind!.ext}`;
  const at = new Date();
  const key = `${at.toISOString().slice(0, 7)}/${randomUUID()}.${kind!.ext}`;
  const { store, connectionId } = await storeForNew();
  await store.put(key, body, kind!.mime);
  const file = await StoredFile.create({
    name, mime: kind!.mime, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), key,
    uploadedBy: actor.userId, driverId: actor.driverId, connectionId, at,
  });
  return present(file);
}

/** A driver's own records: their driver record, their trips, and the loads on them. */
async function drivers(use: { entity: string; recordId: unknown }, driverId: string) {
  if (use.entity === 'drivers') return String(use.recordId) === driverId;
  if (use.entity === 'trips') return Boolean(await Trip.exists({ _id: use.recordId, driverId }));
  if (use.entity === 'consignments') {
    const load = await Consignment.findById(use.recordId).select('tripId').lean();
    return Boolean(load && await Trip.exists({ _id: load.tripId, driverId }));
  }
  return false;
}

/**
 * Who may open a file. Its uploader always. A file on records (#97): whoever can read one of those records, and a
 * driver for their own driver record, trips and loads. Any other file, as before: staff who read driver documents,
 * and a driver for what was filed for them.
 */
async function canSee(file: StoredFileRecord, actor: FileActor, strict = false) {
  if (String(file.uploadedBy) === actor.userId) return true;
  // Stored for this driver, e.g. a photo they sent on WhatsApp (#112): theirs.
  if (actor.driverId && file.driverId && String(file.driverId) === actor.driverId) return true;
  const uses = file.usedBy ?? [];
  for (const use of uses) {
    if (actor.driverId ? await drivers(use, actor.driverId) : actor.can(use.entity, 'read')) return true;
  }
  if (actor.driverId) return Boolean(await DriverDocument.exists({ driverId: actor.driverId, 'file.fileId': file._id }));
  if (uses.length || !actor.can('driver-documents', 'read')) return false;
  // Putting a file into a company field (strict): someone else's upload only if it really is a driver's document.
  return !strict || Boolean(await DriverDocument.exists({ 'file.fileId': file._id }));
}

export async function open(id: string, actor: FileActor): Promise<{ file: ReturnType<typeof present>; stream: Readable }> {
  const file = await StoredFile.findById(id).lean();
  if (!file || !(await canSee(file, actor))) throw new NotFoundError('File not found');
  return { file: present(file), stream: await (await storeOf(file)).open(file.key) };
}

/** A file named in a record must exist and be one the person filing it may open: nobody attaches a file they can't see. */
export async function attachable(id: string, actor: FileActor) {
  const file = await StoredFile.findById(id).lean();
  if (!file || !(await canSee(file, actor))) throw new ValidationError('The attached file was not found');
  return present(file);
}

// Company file fields (#97) find their files, and record where they are used, through these.
setFileHooks({
  async attachable(id, actor) {
    const file = await StoredFile.findById(id).lean();
    // Without a person (an import, a seed, a job) the file only has to exist.
    if (!file || (actor && !(await canSee(file, actor, true)))) return null;
    return present(file);
  },
  async link(entity, recordId, uses) {
    const record = new Types.ObjectId(recordId);
    for (const use of uses) {
      await StoredFile.updateOne(
        { _id: use.fileId, usedBy: { $not: { $elemMatch: { entity, recordId: record, field: use.field } } } },
        { $push: { usedBy: { entity, recordId: record, field: use.field } } },
      );
    }
  },
});
