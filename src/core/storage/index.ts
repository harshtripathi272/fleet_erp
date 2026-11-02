import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { NotFoundError } from '../errors/index.js';

/**
 * Where uploaded files live, chosen per installation by `FILE_STORAGE`: a folder on the server, or a
 * Google Cloud Storage bucket. Callers only see keys; nothing else depends on the backend chosen.
 */
export interface FileStore {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

function localStore(root: string): FileStore {
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

async function gcsStore(bucketName: string): Promise<FileStore> {
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

let store: Promise<FileStore> | undefined;

export function fileStore(): Promise<FileStore> {
  store ??= env.FILE_STORAGE === 'gcs' ? gcsStore(env.GCS_BUCKET!) : Promise.resolve(localStore(env.FILE_STORAGE_DIR));
  return store;
}

/** Lets tests keep files in memory. */
export function setFileStore(next: FileStore) {
  store = Promise.resolve(next);
}
