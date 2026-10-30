import { Schema, model } from 'mongoose';

const auditSchema = new Schema({
  entity: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, required: true, enum: ['create', 'update', 'archive', 'restore', 'delete', 'custom'] },
  summary: String,
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  requestId: String,
  changes: { type: [{ _id: false, path: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed }], default: [] },
  at: { type: Date, default: () => new Date() },
}, { versionKey: false, strict: 'throw' });

auditSchema.index({ entity: 1, entityId: 1, at: -1 });
auditSchema.index({ actorId: 1, at: -1 });
auditSchema.index({ at: -1 });

export const AuditLog = model('AuditLog', auditSchema);
