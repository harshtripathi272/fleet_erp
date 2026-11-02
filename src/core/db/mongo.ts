import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../logger/index.js';

mongoose.set('strictQuery', true);

export async function connectMongo(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  const connection = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: true });
  logger.info({ database: mongoose.connection.name }, 'MongoDB connected');
  return connection;
}

/** Builds every declared index so unique constraints exist before requests arrive. */
export async function syncIndexes(): Promise<void> {
  const { migrateUserIndexes } = await import('../../modules/users/user.model.js');
  await migrateUserIndexes();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export function mongoState(): 'connected' | 'connecting' | 'disconnected' | 'disconnecting' {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const;
  return states[mongoose.connection.readyState as number] ?? 'disconnected';
}
