import { z } from 'zod';

export const healthQuerySchema = z.strictObject({});
export type HealthQuery = z.infer<typeof healthQuerySchema>;
