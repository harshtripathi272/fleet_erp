import { env } from '../../config/env.js';
import { cloudinaryStore, gcsStore, localStore } from '../connections/providers/storage.js';
import type { FileStore } from '../connections/types.js';

export type { FileStore } from '../connections/types.js';

/**
 * Where uploaded files live. Callers only see keys. New files go where the storage connection says (#59);
 * each file remembers the connection that stored it, so switching storage never strands older files.
 * Without a storage connection, the server's own FILE_STORAGE setting is used, as it was before.
 */
export interface StoreResolver {
  forNew(): Promise<{ store: FileStore; connectionId?: string }>;
  forFile(connectionId?: string): Promise<FileStore>;
}

let server: Promise<FileStore> | undefined;
const serverStore = () => (server ??= env.FILE_STORAGE === 'gcs' ? gcsStore(env.GCS_BUCKET!)
  : env.FILE_STORAGE === 'cloudinary' ? Promise.resolve(cloudinaryStore({ cloudName: env.CLOUDINARY_CLOUD_NAME!, folder: env.CLOUDINARY_FOLDER }, { apiKey: env.CLOUDINARY_API_KEY!, apiSecret: env.CLOUDINARY_API_SECRET! }))
  : Promise.resolve(localStore(env.FILE_STORAGE_DIR)));

let resolver: StoreResolver = { forNew: async () => ({ store: await serverStore() }), forFile: () => serverStore() };
/** The connections module puts its own resolver here when it loads. */
export function setStoreResolver(next: StoreResolver) { resolver = next; }

let override: FileStore | undefined;
/** Lets tests keep every file in memory, whatever storage is set up. */
export function setFileStore(next: FileStore) { override = next; }

/** Where to put a new file, and the connection to record on it (none for the server's own storage). */
export async function storeForNew(): Promise<{ store: FileStore; connectionId?: string }> {
  return override ? { store: override } : resolver.forNew();
}

/** Where an existing file is, from the connection recorded on it. */
export async function storeOf(file: { connectionId?: unknown }): Promise<FileStore> {
  return override ?? resolver.forFile(file.connectionId ? String(file.connectionId) : undefined);
}

/** The server's own storage (FILE_STORAGE), for files stored before connections or with none switched on. */
export const serverFileStore = () => override ?? serverStore();
