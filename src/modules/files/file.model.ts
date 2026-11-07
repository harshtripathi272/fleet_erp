import { model, Schema, type Types } from 'mongoose';
import { ObjectId, schemaOptions } from '../../core/masters/schema.js';

export interface StoredFileRecord {
  _id: Types.ObjectId;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Where the bytes are in the configured storage (a folder or a bucket). */
  key: string;
  uploadedBy: Types.ObjectId;
  /** Set when a driver uploaded it from the driver app. */
  driverId?: Types.ObjectId;
  /** The storage connection that holds it; absent for the server's own storage (FILE_STORAGE). */
  connectionId?: Types.ObjectId;
  /**
   * The records whose fields hold it (#97): whoever can read one of them can open the file. Written when the
   * record saves and never removed, so a replaced file can still be opened from the record's history.
   */
  usedBy?: { entity: string; recordId: Types.ObjectId; field: string }[];
  at: Date;
}

/** An uploaded file: a document photo or PDF. Records point at it by id; the bytes live in file storage. */
const storedFileSchema = new Schema<StoredFileRecord>({
  name: { type: String, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true, min: 1 },
  sha256: { type: String, required: true },
  key: { type: String, required: true },
  uploadedBy: { type: ObjectId, ref: 'User', required: true },
  driverId: { type: ObjectId, ref: 'Driver' },
  connectionId: { type: ObjectId, ref: 'Connection' },
  usedBy: { type: [{ _id: false, entity: String, recordId: ObjectId, field: String }], default: undefined },
  at: { type: Date, required: true },
}, { ...schemaOptions, collection: 'files' });
storedFileSchema.index({ key: 1 }, { unique: true });
storedFileSchema.index({ uploadedBy: 1, at: -1 });

export const StoredFile = model<StoredFileRecord>('StoredFile', storedFileSchema);
