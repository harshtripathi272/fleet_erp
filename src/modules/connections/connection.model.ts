import { model, Schema } from 'mongoose';
import { KINDS } from '../../core/connections/index.js';
import { codeNameFields, uniqueIndex } from '../../core/masters/define.js';
import { masterModel, masterSchema } from '../../core/masters/schema.js';

/**
 * One set-up of an outside service: its kind, its provider, the provider's settings, and the names of
 * the server settings that hold its secrets. Secret values are never stored here.
 */
const lastTestSchema = new Schema({ at: Date, ok: Boolean, message: String, to: String }, { _id: false });
const lastErrorSchema = new Schema({ at: Date, message: String }, { _id: false });
const connectionSchema = masterSchema({
  ...codeNameFields,
  kind: { type: String, enum: KINDS, required: true },
  provider: { type: String, required: true },
  enabled: { type: Boolean, default: false },
  /** The provider's own settings, checked against its fields on every save. */
  settings: { type: Schema.Types.Mixed, default: undefined },
  /** For each secret the provider needs, the environment variable (or Secret Manager entry) holding it. */
  secrets: { type: Schema.Types.Mixed, default: undefined },
  /** For providers that push to us: the environment variable holding this connection's signing secret. */
  webhookSecretEnv: String,
  /** Kept by the system for the Connections screen. */
  lastTest: { type: lastTestSchema, default: undefined },
  lastError: { type: lastErrorSchema, default: undefined },
  lastUsedAt: Date,
}, { collection: 'connections' });
uniqueIndex(connectionSchema, { code: 1 });
// One switched-on connection per kind, so nothing ever has to choose between two.
connectionSchema.index({ kind: 1 }, { unique: true, name: 'one_enabled_per_kind', partialFilterExpression: { enabled: true, status: 'active' } });
export const Connection = masterModel('Connection', connectionSchema);

/** One-time changes to stored data, each run once per installation and recorded here. */
export const Migration = model('Migration', new Schema({ _id: String, at: Date, note: String }, { versionKey: false, collection: 'migrations' }));
