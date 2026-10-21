import { model, type Types } from 'mongoose';
import { masterSchema } from '../../core/masters/schema.js';

export interface RoleRecord {
  _id: Types.ObjectId;
  key: string;
  name: string;
  description?: string;
  isSystem: boolean;
  permissions: Array<{ resource: string; actions: string[] }>;
  status: 'active' | 'inactive' | 'archived';
}

const roleSchema = masterSchema({
  key: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: String,
  isSystem: { type: Boolean, default: false },
  permissions: {
    type: [{ _id: false, resource: { type: String, required: true }, actions: { type: [String], required: true } }],
    default: [],
  },
});
roleSchema.index({ key: 1 }, { unique: true });

export const Role = model<RoleRecord>('Role', roleSchema);
