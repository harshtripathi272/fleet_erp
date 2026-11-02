import type { Action } from '../core/masters/types.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email?: string;
  /** Set when the account belongs to a driver (the driver app). */
  driverId?: string;
  name: string;
  roles: string[];
  permissions: Array<{ resource: string; actions: string[] }>;
  can: (resource: string, action: Action) => boolean;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}
export {};
