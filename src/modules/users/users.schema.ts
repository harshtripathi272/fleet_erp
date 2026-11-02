import { z } from 'zod';
import { baseShape, email, name, objectId, phone, toUpdateSchema } from '../../core/masters/zod.js';

/** 8-128 characters with at least one letter and one digit. */
export const password = z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use at least one letter and one digit');

const userShape = {
  name,
  email,
  phone: phone.optional(),
  roleIds: z.array(objectId).max(20),
  ...baseShape,
};

/** Admin-created users: without a password they receive a set-password e-mail. */
export const createUserSchema = z.strictObject({ ...userShape, password: password.optional() });
export const updateUserSchema = toUpdateSchema(userShape);

/** A driver's sign-in for the driver app. A new access needs a password; later changes may send only what changes. */
export const driverAccessSchema = z.strictObject({ phone: phone.optional(), email: email.optional(), password: password.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Send the phone, e-mail or password');
export const driverAccessParams = z.strictObject({ driverId: objectId });
