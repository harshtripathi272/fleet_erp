import { z } from 'zod';
import { email, name, phone } from '../../core/masters/zod.js';
import { password } from '../users/users.schema.js';

export const registerSchema = z.strictObject({ name, email, password });
/** Staff sign in with their e-mail; drivers, who often have none, with their phone number. */
export const loginSchema = z.strictObject({ email: email.optional(), phone: phone.optional(), password: z.string().min(1).max(128) })
  .refine((v) => Boolean(v.email) !== Boolean(v.phone), 'Give your e-mail or your phone number');
export const refreshSchema = z.strictObject({ refreshToken: z.string().min(20).max(200) });
export const forgotPasswordSchema = z.strictObject({ email });
export const resetPasswordSchema = z.strictObject({ token: z.string().min(20).max(200), password });
export const changePasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const updateMeSchema = z.strictObject({ name: name.optional(), phone: phone.nullable().optional() })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
