import mongoose from 'mongoose';
import { providerFor } from '../../core/connections/index.js';
import { logger } from '../../core/logger/index.js';
import type { Plain } from '../../core/masters/types.js';
import { Company } from '../company/company.model.js';
import { Role } from '../roles/role.model.js';
import { Connection, Migration } from './connection.model.js';

const STEP = 'connections-v1';

/** Old message-connection fields, by channel, and where they go on the provider's settings. */
const SETTINGS_BY_CHANNEL: Record<string, string[]> = { email: ['host', 'port', 'secure', 'user', 'from'], sms: ['senderId'], whatsapp: [] };
/** The old WhatsApp provider's key; the Simulated one has the same behaviour. */
const RENAMED: Record<string, string> = { simulator: 'simulated' };

/**
 * Moves what existed before connections (#59) onto them, once per installation. Nothing is lost or
 * deleted: each message connection is copied with the same id (the outbox keeps pointing at it), a
 * company's rate feed becomes a rates connection, and custom roles that could manage message
 * connections can manage connections. The old collection is left as it was.
 */
export async function migrateToConnections() {
  if (await Migration.exists({ _id: STEP })) return { moved: 0 };
  let moved = 0;

  const old = await mongoose.connection.db!.collection('messageconnections').find({}).toArray().catch(() => [] as Plain[]);
  for (const c of old as Plain[]) {
    if (await Connection.exists({ _id: c._id })) continue;
    const channel = String(c.channel);
    const provider = RENAMED[String(c.provider)] ?? String(c.provider);
    const settings = Object.fromEntries(SETTINGS_BY_CHANNEL[channel]!.filter((k) => c[k] !== undefined && c[k] !== null).map((k) => [k, c[k]]));
    const secretKey = providerFor(channel as 'email', provider)?.secrets?.[0]?.key ?? (channel === 'email' ? 'password' : 'apiKey');
    const last = c.lastTest as Plain | undefined;
    await Connection.collection.insertOne({
      _id: c._id, code: c.code, name: c.name, ...(c.description ? { description: c.description } : {}),
      kind: channel, provider, enabled: Boolean(c.enabled),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(c.secretEnv ? { secrets: { [secretKey]: c.secretEnv } } : {}),
      ...(last ? { lastTest: { at: last.at, ok: last.ok, to: last.to, message: last.error ?? (last.ok ? 'Test message sent' : undefined) } } : {}),
      ...(c.lastError ? { lastError: c.lastError } : {}),
      ...(c.lastSentAt ? { lastUsedAt: c.lastSentAt } : {}),
      status: c.status ?? 'active', version: c.version ?? 1, custom: c.custom ?? {},
      ...Object.fromEntries(['validFrom', 'validTo', 'branchIds', 'tags', 'notes', 'externalRefs', 'archivedAt', 'archivedBy', 'archiveReason', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'].filter((k) => c[k] !== undefined).map((k) => [k, c[k]])),
    } as Plain);
    moved += 1;
  }

  // The rate feed's provider was a company setting with the key in RATE_FEED_API_KEY.
  const company = await Company.findOne().select('rateFeed').lean() as Plain | null;
  const feed = (company?.rateFeed as Plain | undefined)?.provider as string | undefined;
  if (feed && feed !== 'manual' && !(await Connection.exists({ kind: 'rates' }))) {
    const provider = providerFor('rates', feed);
    if (provider) {
      const now = new Date();
      await Connection.collection.insertOne({
        _id: new mongoose.Types.ObjectId(), code: 'RATES', name: provider.label, kind: 'rates', provider: feed, enabled: true,
        ...(provider.secrets?.some((s) => s.required) ? { secrets: { [provider.secrets[0]!.key]: 'RATE_FEED_API_KEY' } } : {}),
        status: 'active', version: 1, custom: {}, createdAt: now, updatedAt: now,
      } as Plain);
      moved += 1;
    }
  }

  // Custom roles keep the same rights under the new name.
  for (const role of await Role.find({ 'permissions.resource': 'message-connections' }).lean() as unknown as Plain[]) {
    const permissions = (role.permissions as Array<{ resource: string; actions: string[] }>);
    const already = permissions.some((p) => p.resource === 'connections');
    const next = already ? permissions.filter((p) => p.resource !== 'message-connections') : permissions.map((p) => (p.resource === 'message-connections' ? { ...p, resource: 'connections' } : p));
    await Role.collection.updateOne({ _id: role._id as never }, { $set: { permissions: next } });
  }

  await Migration.create({ _id: STEP, at: new Date(), note: `${moved} connection${moved === 1 ? '' : 's'} moved` });
  if (moved) logger.info({ moved }, 'Message connections and the rate feed moved onto connections');
  return { moved };
}
