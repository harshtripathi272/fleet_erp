import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { Plain } from './types.js';

/**
 * File, image and document fields (#97). A company field of one of these types holds `{ fileId, name, mime, size }`
 * (a list of them for `files`), never the bytes or an address. The bytes stay in file storage; the record keeps the
 * name and size so a list can show them without a lookup per row. The files module plugs in how a file is found and
 * who may use it (setFileHooks), so this file has no storage or permission code of its own.
 */

export const FILE_TYPES = ['image', 'document', 'files'] as const;
export const isFileType = (type: unknown) => (FILE_TYPES as readonly string[]).includes(String(type));

/** Kinds of file a field can take. Pictures and PDFs by default; a company can widen a field to Word and Excel. */
export const FILE_KINDS = ['images', 'pdf', 'word', 'excel'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const KIND_MIMES: Record<FileKind, string[]> = {
  images: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  pdf: ['application/pdf'],
  word: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'],
  excel: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
};
const KIND_NAME: Record<FileKind, { one: string; many: string }> = {
  images: { one: 'a picture', many: 'pictures' }, pdf: { one: 'a PDF', many: 'PDFs' },
  word: { one: 'a Word file', many: 'Word files' }, excel: { one: 'an Excel file', many: 'Excel files' },
};
export const kindOf = (mime: string) => FILE_KINDS.find((k) => KIND_MIMES[k].includes(mime));
/** "PDFs and pictures", "pictures", "PDFs, pictures and Word files". */
export function kindsInWords(kinds: readonly FileKind[]) {
  const names = [...kinds].sort((a, b) => (a === 'pdf' ? -1 : b === 'pdf' ? 1 : 0)).map((k) => KIND_NAME[k].many);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'files';
}
/** "That's a Word file; this field takes PDFs and pictures." */
export const refusedKind = (mime: string | undefined, kinds: readonly FileKind[]) => {
  const kind = mime ? kindOf(mime) : undefined;
  return `${kind ? `That's ${KIND_NAME[kind].one}` : "That kind of file isn't accepted"}; this field takes ${kindsInWords(kinds)}.`;
};

/** What a file field accepts: an image field only pictures, the others what the company chose (pictures and PDFs by default). */
export interface FileOptions { type: string; accept?: FileKind[]; maxSizeMb?: number; maxFiles?: number; withExpiry?: boolean }
export const acceptedKinds = (field: FileOptions): FileKind[] => (field.type === 'image' ? ['images'] : field.accept?.length ? field.accept : ['images', 'pdf']);
export const mimesFor = (field: FileOptions) => acceptedKinds(field).flatMap((k) => KIND_MIMES[k]);
export const DEFAULT_MAX_FILES = 10;
/** A file field's limits, for the upload control to say what it takes before anything is sent. */
export const fileOptions = (f: Plain) => (isFileType(f.type)
  ? { accept: acceptedKinds(f as unknown as FileOptions), maxSizeMb: Number(f.maxSizeMb ?? env.UPLOAD_MAX_MB), ...(f.type === 'files' ? { maxFiles: Number(f.maxFiles ?? DEFAULT_MAX_FILES) } : {}), ...(f.withExpiry ? { withExpiry: true } : {}) }
  : {});
export const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 1048576 ? 1 : 0)} MB`;

/** Who is asking, for the request being served: set once by `authenticate`, read wherever a file is attached. */
export interface FileActor { userId: string; driverId?: string; can: (resource: string, action: 'create' | 'read' | 'update' | 'delete') => boolean }
export const requestActor = new AsyncLocalStorage<FileActor>();
export const currentActor = () => requestActor.getStore();

export interface FileInfo { id: string; name: string; mime: string; size: number }
interface FileHooks {
  /** The file, if it exists and this person may attach it (theirs, or one they can already open); null otherwise. */
  attachable(id: string, actor: FileActor | undefined): Promise<FileInfo | null>;
  /** Notes that a record's field holds these files, so whoever can read the record can open them. */
  link(entity: string, recordId: string, uses: { fileId: string; field: string }[]): Promise<void>;
}
let hooks: FileHooks | undefined;
export const setFileHooks = (next: FileHooks) => { hooks = next; };

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a file id').transform((v) => v.toLowerCase());
// The name, kind and size sent back with a value are ignored: they are always taken from the stored file.
const echoed = { name: z.string().max(300).optional(), mime: z.string().max(200).optional(), size: z.number().optional() };

export function fileValueSchema(field: FileOptions): z.ZodType {
  if (field.type === 'files') {
    return z.array(z.strictObject({ fileId: objectId, ...echoed })).min(1).max(field.maxFiles ?? DEFAULT_MAX_FILES, `At most ${field.maxFiles ?? DEFAULT_MAX_FILES} files`)
      .refine((list) => new Set(list.map((f) => f.fileId)).size === list.length, 'The same file is attached twice');
  }
  return z.strictObject({
    fileId: objectId, ...echoed,
    ...(field.type === 'document' && field.withExpiry ? { expiresOn: z.iso.date('A date, e.g. 2027-03-31').optional() } : {}),
  });
}

type One = { fileId: string; expiresOn?: string } & Plain;
const ones = (v: unknown): One[] => (Array.isArray(v) ? v : v ? [v] : []) as One[];

/**
 * Fills each changed file value from the stored file, after checking the person may attach it and that the field
 * takes its kind and size. A value that is already on the record is kept as it is, even if someone else attached it.
 */
export async function resolveFileValues(fields: Array<FileOptions & { key: string }>, result: Plain, base: Plain, errors: Record<string, string[]>) {
  const actor = currentActor();
  for (const field of fields.filter((f) => isFileType(f.type) && result[f.key] !== undefined && !errors[f.key])) {
    const before = new Map(ones(base[field.key]).map((f) => [String(f.fileId), f]));
    const kinds = acceptedKinds(field);
    const filled: Plain[] = [];
    for (const v of ones(result[field.key])) {
      const kept = before.get(v.fileId);
      if (kept) { filled.push({ fileId: v.fileId, name: kept.name, mime: kept.mime, size: kept.size, ...(v.expiresOn ? { expiresOn: v.expiresOn } : {}) }); continue; }
      const file = hooks ? await hooks.attachable(v.fileId, actor) : null;
      if (!file) { (errors[field.key] ??= []).push('The attached file was not found'); continue; }
      if (!mimesFor(field).includes(file.mime)) { (errors[field.key] ??= []).push(refusedKind(file.mime, kinds)); continue; }
      if (field.maxSizeMb && file.size > field.maxSizeMb * 1048576) { (errors[field.key] ??= []).push(`${file.name} is ${megabytes(file.size)}; this field takes files up to ${field.maxSizeMb} MB.`); continue; }
      filled.push({ fileId: file.id, name: file.name, mime: file.mime, size: file.size, ...(v.expiresOn ? { expiresOn: v.expiresOn } : {}) });
    }
    if (!errors[field.key]) result[field.key] = field.type === 'files' ? filled : filled[0];
  }
}

/** Every file a record's company values hold (`custom`, or a custom master's `data`), by field. */
export function fileUses(record: Plain): { fileId: string; field: string }[] {
  const out: { fileId: string; field: string }[] = [];
  for (const holder of ['custom', 'data'] as const) {
    for (const [key, value] of Object.entries((record[holder] ?? {}) as Plain)) {
      for (const v of ones(value)) {
        if (v && typeof v === 'object' && typeof v.fileId === 'string' && typeof v.mime === 'string') out.push({ fileId: v.fileId, field: `${holder}.${key}` });
      }
    }
  }
  return out;
}

/** After a record is saved: its files can be opened by whoever can read it. Replaced files stay linked, for its history. */
export async function linkRecordFiles(entity: string, recordId: unknown, record: Plain) {
  const uses = fileUses(record);
  if (uses.length && hooks) await hooks.link(entity, String(recordId), uses);
}

/** A mongoose plugin for records saved outside the master engine (trips, loads, requests): links their files on save. */
export const fileLinks = (entity: string) => (schema: { post: (event: 'save', fn: (doc: { _id: unknown; toObject: () => Plain }) => Promise<void>) => void }) => {
  schema.post('save', async (doc) => { await linkRecordFiles(entity, doc._id, doc.toObject()); });
};
