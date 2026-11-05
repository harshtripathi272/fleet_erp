import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import { NotFoundError } from '../../errors/index.js';
import { registerProvider } from '../registry.js';
import type { FileStore } from '../types.js';

/*
 * Where uploaded files live. A file remembers which connection stored it (`storedFile.connectionId`), so
 * switching storage only changes where new files go; older ones are still read from where they are.
 */

/** A folder on the server. Its place is the server's FILE_STORAGE_DIR, never chosen on screen. */
export function localStore(root: string): FileStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw new NotFoundError('File not found');
    return path;
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { flag: 'wx' });
    },
    async open(key) {
      const path = pathOf(key);
      if (!(await stat(path).catch(() => null))?.isFile()) throw new NotFoundError('File not found');
      return createReadStream(path);
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

export async function gcsStore(bucketName: string): Promise<FileStore> {
  // Loaded only when an installation stores files on GCS.
  const { Storage } = await import('@google-cloud/storage');
  const bucket = new Storage().bucket(bucketName);
  return {
    async put(key, body, mime) {
      await bucket.file(key).save(body, { contentType: mime, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    },
    async open(key) {
      const file = bucket.file(key);
      const [exists] = await file.exists();
      if (!exists) throw new NotFoundError('File not found');
      return file.createReadStream();
    },
    async remove(key) {
      await bucket.file(key).delete({ ignoreNotFound: true });
    },
  };
}

/** Writes a small file and deletes it again: what "Test connection" does for every store. */
async function roundTrip(store: FileStore) {
  const key = `connection-test/${randomUUID()}.txt`;
  await store.put(key, Buffer.from('Connection test'), 'text/plain');
  await store.remove(key);
  return { ok: true, message: 'Wrote a test file and deleted it again.' };
}

registerProvider({
  kind: 'storage', key: 'local', label: 'Server folder',
  description: "A folder on the server (FILE_STORAGE_DIR). Fine on one server with a backed-up disk; files are lost with the server's disk otherwise.",
  fields: z.strictObject({}),
  test: async () => roundTrip(localStore(env.FILE_STORAGE_DIR)),
  open: () => ({ store: async () => localStore(env.FILE_STORAGE_DIR) }),
});

registerProvider({
  kind: 'storage', key: 'gcs', label: 'Google Cloud Storage',
  description: "A Cloud Storage bucket. The server signs in with its own Google service account, so no key is stored (see docs/deploy-gcp.md).",
  fields: z.strictObject({ bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/, 'A bucket name, e.g. acme-fleet-files') }),
  hints: { bucket: "The bucket's name, without gs://" },
  test: async (ctx) => roundTrip(await gcsStore(String(ctx.settings.bucket))),
  open: (ctx) => ({ store: () => gcsStore(String(ctx.settings.bucket)) }),
});

/* Amazon S3, and services that speak its API (Cloudflare R2, Wasabi, MinIO), signed with AWS Signature V4. */

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding of each path segment, as S3 expects it. */
const encodeKey = (key: string) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

interface S3Settings { bucket: string; region: string; endpoint?: string }

/** Signs one S3 request (AWS Signature Version 4, unsigned query, signed payload). */
export function signS3(input: { method: string; url: URL; region: string; accessKeyId: string; secretAccessKey: string; body?: Buffer; headers?: Record<string, string>; now?: Date }) {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(input.body ?? '');
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: input.url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [input.method, input.url.pathname, '', ...names.map((n) => `${n}:${headers[n]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export function s3Store(s: S3Settings, keys: { accessKeyId: string; secretAccessKey: string }): FileStore {
  const urlOf = (key: string) => new URL(s.endpoint
    ? `${s.endpoint.replace(/\/$/, '')}/${encodeURIComponent(s.bucket)}/${encodeKey(key)}`
    : `https://${s.bucket}.s3.${s.region}.amazonaws.com/${encodeKey(key)}`);
  const call = async (method: string, key: string, body?: Buffer, mime?: string) => {
    const url = urlOf(key);
    const headers = signS3({ method, url, region: s.region, ...keys, body, headers: mime ? { 'content-type': mime } : {} });
    const res = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(60_000) });
    if (res.status === 404 && method === 'GET') throw new NotFoundError('File not found');
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 answered ${res.status}: ${/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? res.statusText}`);
    }
    return res;
  };
  return {
    async put(key, body, mime) { await call('PUT', key, body, mime); },
    async open(key) {
      const res = await call('GET', key);
      return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    },
    async remove(key) { await call('DELETE', key); },
  };
}

registerProvider({
  kind: 'storage', key: 's3', label: 'Amazon S3 or compatible',
  description: 'An S3 bucket, or a service with the same API such as Cloudflare R2, Wasabi or MinIO.',
  fields: z.strictObject({
    bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'A bucket name, e.g. acme-fleet-files'),
    region: z.string().trim().regex(/^[a-z0-9-]{2,30}$/, 'A region, e.g. af-south-1').default('af-south-1'),
    endpoint: z.url().refine((u) => /^https:\/\//.test(u), 'An https address').optional(),
  }),
  labels: { endpoint: 'Service address' },
  hints: { endpoint: 'Only for S3-compatible services, e.g. https://<account>.r2.cloudflarestorage.com. Empty for Amazon S3.', region: '"auto" for Cloudflare R2' },
  secrets: [{ key: 'accessKeyId', label: 'Access key ID', required: true }, { key: 'secretAccessKey', label: 'Secret access key', required: true }],
  test: async (ctx) => roundTrip(s3Store(ctx.settings as unknown as S3Settings, { accessKeyId: ctx.secret('accessKeyId')!, secretAccessKey: ctx.secret('secretAccessKey')! })),
  open: (ctx) => ({ store: async () => s3Store(ctx.settings as unknown as S3Settings, { accessKeyId: ctx.secret('accessKeyId')!, secretAccessKey: ctx.secret('secretAccessKey')! }) }),
});
