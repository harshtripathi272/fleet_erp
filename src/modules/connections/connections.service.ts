import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  type Capabilities, contextFor, describeFields, describeSecrets, type InboundCounts, type InboundResult, isKind, type Kind, KIND_INFO, KINDS,
  type MessageSender, type Provider, providerFor, providersOf, scrub, SECRET_ENV, SECRET_ENV_HINT, secretEnvName, secretSetup,
  type SecretTarget, simulatedProvider, verifySignature,
} from '../../core/connections/index.js';
import { Company } from '../company/company.model.js';
import { productName } from '../company/brand.service.js';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../core/errors/index.js';
import { logger } from '../../core/logger/index.js';
import { defineMaster } from '../../core/masters/define.js';
import { GROUPS } from '../../core/masters/groups.js';
import type { Plain } from '../../core/masters/types.js';
import { baseShape, code, name, text, toUpdateSchema } from '../../core/masters/zod.js';
import { type FileStore, serverFileStore, setStoreResolver } from '../../core/storage/index.js';
import { SystemState } from '../auth/systemState.model.js';
import { Connection } from './connection.model.js';

export const MESSAGE_KINDS = ['email', 'sms', 'whatsapp'] as const;
const isMessageKind = (kind: string) => (MESSAGE_KINDS as readonly string[]).includes(kind);

const secretName = z.string().trim().regex(SECRET_ENV, SECRET_ENV_HINT);
export const connectionShape = {
  code, name, description: text(500).optional(),
  kind: z.enum(KINDS),
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/, 'A provider key, e.g. smtp or simulated'),
  enabled: z.boolean().optional(),
  settings: z.record(z.string().max(60), z.unknown()).optional(),
  secrets: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), secretName).optional(),
  webhookSecretEnv: secretName.optional(),
  ...baseShape,
};
export const createConnectionSchema = z.strictObject(connectionShape);
export const updateConnectionSchema = toUpdateSchema(connectionShape);
export const testConnectionSchema = z.strictObject({ to: z.string().trim().min(3).max(254).optional() });

/* What whoever set this company up lets it choose (#113). Held apart from the company's own settings, so no screen or API it can reach changes them: only a company file does. */

export interface ConnectionRule { providers?: string[]; locked?: boolean }
const RULES = 'connection-rules';
export const connectionRules = async () => ((await SystemState.findOne({ key: RULES }).lean<{ value?: Record<string, ConnectionRule> }>())?.value ?? {});
export const saveConnectionRules = async (rules: Record<string, ConnectionRule>) => { await SystemState.updateOne({ key: RULES }, { $set: { value: rules } }, { upsert: true }); };

/** Refuses what the rules don't allow. A company file's own step has no person behind it, so it isn't held to them. */
async function checkRules(kind: string, provider: string | undefined, actorId: string | undefined) {
  if (!actorId) return;
  const rule = (await connectionRules())[kind];
  if (!rule) return;
  const label = KIND_INFO[kind as Kind]?.label ?? kind;
  if (rule.locked) throw new ForbiddenError(`${label} was set up for this company and can't be changed here`);
  if (provider && rule.providers?.length && !rule.providers.includes(provider)) throw new ValidationError(`That service isn't offered for ${label} here`, { provider: [`Choose from: ${rule.providers.map((k) => providerFor(kind as Kind, k)?.label ?? k).join(', ')}`] });
}

/** Stops changes to a locked connection that don't pass through its form: switching off, archiving, deleting. */
export async function guardConnectionChange(method: string, path: string, body: Plain | undefined, actorId?: string) {
  if (method === 'GET' || /\/test(-draft)?$/.test(path)) return;
  const id = /^\/([0-9a-f]{24})/i.exec(path)?.[1];
  const doc = id ? await Connection.findById(id).select('kind provider').lean<{ kind: string; provider: string }>() : null;
  const kind = doc?.kind ?? (body?.kind as string | undefined);
  if (kind) await checkRules(kind, (body?.provider as string | undefined) ?? doc?.provider, actorId);
}

/** Checks a connection against its provider: known provider, settings that fit its fields, only its secrets. */
async function prepare(data: Plain, ctx?: { actorId?: string }) {
  await checkRules(String(data.kind), String(data.provider), ctx?.actorId);
  const errors: Record<string, string[]> = {};
  const add = (key: string, message: string) => { (errors[key] ??= []).push(message); };
  const kind = data.kind as Kind;
  const provider = providerFor(kind, String(data.provider));
  if (!provider) {
    add('provider', `For ${KIND_INFO[kind].label}, use ${providersOf(kind).map((p) => p.key).join(', ')}`);
    throw new ValidationError('Connection is not valid', errors);
  }
  if (provider.comingSoon) {
    add('provider', provider.comingSoon);
    throw new ValidationError('Connection is not valid', errors);
  }
  const parsed = provider.fields.safeParse(data.settings ?? {});
  if (parsed.success) data.settings = Object.keys(parsed.data).length ? parsed.data : undefined;
  else for (const issue of parsed.error.issues) add(issue.path.length ? `settings.${issue.path.join('.')}` : 'settings', issue.message);
  const wanted = new Map(describeSecrets(provider).map((s) => [s.key, s]));
  for (const key of Object.keys((data.secrets ?? {}) as Plain)) if (!wanted.has(key)) add(`secrets.${key}`, `${provider.label} does not use this secret`);
  // Each secret's server setting is named from the connection's code unless one is given (#98): nobody types it.
  const names = { ...((data.secrets ?? {}) as Record<string, string>) };
  for (const spec of wanted.values()) names[spec.key] ??= secretEnvName(String(data.code), spec.key);
  data.secrets = Object.keys(names).length ? names : undefined;
  const ownSignature = Boolean(provider.verifyInbound);
  if (provider.inbound && !ownSignature) data.webhookSecretEnv ??= secretEnvName(String(data.code), 'signingSecret');
  if ((!provider.inbound || ownSignature) && data.webhookSecretEnv) add('webhookSecretEnv', provider.inbound ? `${provider.label} signs its calls itself, so it needs no signing secret of ours` : `${provider.label} does not call us, so it needs no signing secret`);
  if (Object.keys(errors).length) throw new ValidationError('Connection is not valid', errors);
  return data;
}

/** The address a service calls for this connection. */
export const webhookUrlOf = (id: unknown) => `${env.APP_URL.replace(/\/$/, '')}/api/v1/hooks/${String(id)}`;
const takesCalls = (doc: Plain) => Boolean(providerFor(doc.kind as Kind, String(doc.provider))?.inbound);

/** What the screen may know about secrets: each one's setting name and whether the server has it, never its value. */
function present(doc: Plain) {
  const secrets = (doc.secrets ?? {}) as Record<string, string>;
  return {
    secretsSet: Object.fromEntries(Object.entries(secrets).map(([k, envName]) => [k, Boolean(process.env[envName])])),
    ...(doc.webhookSecretEnv ? { webhookSecretSet: Boolean(process.env[String(doc.webhookSecretEnv)]) } : {}),
    ...(takesCalls(doc) ? { webhookUrl: webhookUrlOf(doc._id ?? doc.id) } : {}),
  };
}

export const connectionDefinition = defineMaster({
  key: 'connections', label: 'Connections', singular: 'Connection', group: GROUPS.configuration, lockedChoices: ['kind'],
  description: 'Every outside service: e-mail, SMS, WhatsApp, GPS trackers, exchange rates, map routing, file storage, accounting, fuel cards and mobile money. One switched on per kind; each kind works on its Simulated stand-in until a real one is connected. Passwords and keys stay in server settings; a connection names the setting that holds each one.',
  model: Connection, createSchema: createConnectionSchema, updateSchema: updateConnectionSchema,
  searchFields: ['code', 'name', 'kind', 'provider'],
  columns: ['name', 'kind', 'provider', 'enabled'],
  choiceLabels: { kind: Object.fromEntries(KINDS.map((k) => [k, KIND_INFO[k].label])) },
  immutable: ['kind'],
  filters: {
    kind: { schema: z.enum(KINDS), apply: (v: string) => ({ kind: v }), description: 'Kind' },
    enabled: { schema: z.enum(['true', 'false']), apply: (v: string) => ({ enabled: v === 'true' }), description: 'Switched on' },
  },
  prepare,
  present,
});

/* What each kind uses right now */

export interface InUse<K extends Kind> {
  kind: K;
  provider: Provider<K>;
  /** The switched-on connection, if any; absent when the server's own settings or the Simulated stand-in are used. */
  connection?: Plain;
  via: 'connection' | 'server' | 'simulated';
  capability: Capabilities[K];
}

export const activeConnection = (kind: Kind) => Connection.findOne({ kind, enabled: true, status: 'active' }).lean() as Promise<Plain | null>;

/** A connection's provider and capability, for using it (switched on or not, e.g. to test it). */
export function openConnection<K extends Kind>(connection: Plain): InUse<K> | undefined {
  const kind = connection.kind as K;
  const provider = providerFor(kind, String(connection.provider)) as Provider<K> | undefined;
  if (!provider) return undefined;
  return { kind, provider, connection, via: 'connection', capability: provider.open(contextFor(provider as unknown as Provider, connection as never)) };
}

/** The server's own settings, where today's behaviour used them before any connection existed. */
function serverDefault<K extends Kind>(kind: K): { provider: Provider<K>; connection: Plain } | undefined {
  if (kind === 'email' && env.SMTP_HOST) {
    return { provider: providerFor('email', 'smtp') as Provider<K>, connection: { settings: { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, from: env.SMTP_FROM }, secrets: env.SMTP_USER ? { password: 'SMTP_PASS' } : undefined } };
  }
  if (kind === 'storage') {
    return env.FILE_STORAGE === 'gcs'
      ? { provider: providerFor('storage', 'gcs') as Provider<K>, connection: { settings: { bucket: env.GCS_BUCKET } } }
      : { provider: providerFor('storage', 'local') as Provider<K>, connection: { settings: {} } };
  }
  return undefined;
}

/**
 * What a kind uses now: its switched-on connection; else the server's own settings (e-mail's SMTP_*,
 * storage's FILE_STORAGE), as before connections existed; else its Simulated stand-in.
 */
export async function using<K extends Kind>(kind: K): Promise<InUse<K>> {
  const connection = await activeConnection(kind);
  const opened = connection ? openConnection<K>(connection) : undefined;
  if (opened) return opened;
  if (connection) logger.warn({ kind, provider: connection.provider }, 'A switched-on connection names a provider this server does not have; using the fallback');
  const server = serverDefault(kind);
  if (server) return { kind, provider: server.provider, via: 'server', capability: server.provider.open(contextFor(server.provider as unknown as Provider, server.connection as never)) };
  const simulated = simulatedProvider(kind) as Provider<K>;
  return { kind, provider: simulated, via: 'simulated', capability: simulated.open(contextFor(simulated as unknown as Provider)) };
}

/** Kept on the connection for the screen: when it last worked, and the last thing that went wrong. */
export async function recordUse(connectionId: unknown) {
  if (connectionId) await Connection.updateOne({ _id: connectionId }, { $set: { lastUsedAt: new Date() } });
}
export async function recordError(connectionId: unknown, message: string) {
  if (connectionId) await Connection.updateOne({ _id: connectionId }, { $set: { lastError: { at: new Date(), message: message.slice(0, 500) } } });
}

/* File storage: new files where the storage connection says; each existing file where it was stored. */

const stores = new Map<string, { version: unknown; store: Promise<FileStore> }>();
function storeOnConnection(connection: Plain): Promise<FileStore> {
  const id = String(connection._id);
  const cached = stores.get(id);
  if (cached && cached.version === connection.version) return cached.store;
  const opened = openConnection<'storage'>(connection);
  if (!opened) return Promise.reject(new Error(`This server has no storage provider "${String(connection.provider)}"`));
  const store = opened.capability.store();
  stores.set(id, { version: connection.version, store });
  return store;
}
setStoreResolver({
  async forNew() {
    const connection = await activeConnection('storage');
    return connection ? { store: await storeOnConnection(connection), connectionId: String(connection._id) } : { store: await serverFileStore() };
  },
  async forFile(connectionId) {
    if (!connectionId) return serverFileStore();
    // Switched off or archived, it still holds the files it stored.
    const connection = await Connection.findById(connectionId).lean() as Plain | null;
    if (!connection) throw new Error('The storage connection that holds this file was deleted');
    return storeOnConnection(connection);
  },
});

/* Testing */

type MessageTest = (connection: Plain, to: string, actorId?: string) => Promise<{ ok: boolean; status: string; note?: string; message?: unknown }>;
let messageTest: MessageTest | undefined;
/** Message kinds test by sending a real test message through the dispatcher, which registers itself here. */
export function setMessageTest(test: MessageTest) { messageTest = test; }

/** "Test connection": a test message for message kinds, the provider's own check for the rest. Kept on the connection. */
export async function testConnection(id: string, input: { to?: string }, actorId?: string) {
  const connection = await Connection.findById(id).lean() as Plain | null;
  if (!connection) throw new NotFoundError('Connection not found');
  if (isMessageKind(String(connection.kind))) {
    if (!input.to) throw new ValidationError('Who should get the test message?', { to: [connection.kind === 'email' ? 'An e-mail address' : 'A phone number in international format: + and the country code first'] });
    if (!messageTest) throw new Error('Messaging is not loaded');
    return messageTest(connection, input.to, actorId);
  }
  const provider = providerFor(connection.kind as Kind, String(connection.provider));
  let result: { ok: boolean; message: string };
  if (!provider) result = { ok: false, message: `This server has no provider "${String(connection.provider)}"` };
  else {
    try {
      result = await provider.test(contextFor(provider, connection as never));
    } catch (err) {
      result = { ok: false, message: scrub(err instanceof Error ? err.message : String(err), connection as never) };
    }
  }
  await Connection.updateOne({ _id: connection._id }, { $set: { lastTest: { at: new Date(), ok: result.ok, message: result.message }, ...(result.ok ? {} : { lastError: { at: new Date(), message: result.message } }) } });
  return { ok: result.ok, status: result.ok ? 'ok' : 'failed', note: result.message };
}

/**
 * Tests values not saved yet (#98), so the form and the guided set-up can say "Connected" or exactly what
 * failed before anything is stored. Message kinds send a real test message (not through the outbox, since
 * there is no connection yet); the others run the provider's own check. Simulated providers say so.
 */
export const testDraftSchema = z.strictObject({
  kind: z.enum(KINDS),
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/),
  code: code.optional(),
  settings: z.record(z.string().max(60), z.unknown()).optional(),
  secrets: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), secretName).optional(),
  to: z.string().trim().min(3).max(254).optional(),
});
export type TestDraftInput = z.infer<typeof testDraftSchema>;

export async function testDraft(input: TestDraftInput) {
  const provider = providerFor(input.kind, input.provider);
  if (!provider) throw new ValidationError('Connection is not valid', { provider: [`No ${KIND_INFO[input.kind].label} provider "${input.provider}"`] });
  if (provider.comingSoon) return { ok: false, simulated: false, message: provider.comingSoon };
  const parsed = provider.fields.safeParse(input.settings ?? {});
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) (fields[issue.path.length ? `settings.${issue.path.join('.')}` : 'settings'] ??= []).push(issue.message);
    throw new ValidationError('Fill in the settings first', fields);
  }
  const names = { ...(input.secrets ?? {}) };
  for (const spec of describeSecrets(provider)) names[spec.key] ??= secretEnvName(input.code ?? 'NEW', spec.key);
  const missing = describeSecrets(provider).filter((s) => s.required && !process.env[names[s.key]!]).map((s) => names[s.key]!);
  if (missing.length) return { ok: false, simulated: false, missing, message: `Set ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]} on the server first, restart, then test again.` };
  const draft = { settings: parsed.data, secrets: names } as never;
  const ctx = contextFor(provider, draft);
  try {
    if (isMessageKind(input.kind)) {
      if (!input.to) throw new ValidationError('Who should get the test message?', { to: [input.kind === 'email' ? 'An e-mail address' : 'A phone number in international format: + and the country code first'] });
      if (provider.simulated) return { ok: true, simulated: true, message: 'Simulated: the test message is kept in the outbox view and nothing is sent.' };
      const sender = provider.open(ctx) as MessageSender;
      const product = await productName();
      const sent = await sender.send({ to: input.to, subject: `${product} test message`, text: `This is a test message from ${product}. If you received it, this connection works.` });
      return { ok: true, simulated: false, message: `Sent to ${input.to}${sent.providerRef ? ` (reference ${sent.providerRef})` : ''}. Check it arrived.` };
    }
    const result = await provider.test(ctx);
    return { ok: result.ok, simulated: Boolean(provider.simulated), message: provider.simulated ? `Simulated: ${result.message}` : result.message };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    return { ok: false, simulated: false, message: scrub(err instanceof Error ? err.message : String(err), draft) };
  }
}

/** How to set a connection's secrets on a platform: its setting names and the exact commands (#98). */
export async function secretSetupFor(input: { connectionId?: string; kind?: Kind; provider?: string; code?: string; target: SecretTarget }) {
  let names: string[];
  if (input.connectionId) {
    const connection = await Connection.findById(input.connectionId).lean() as Plain | null;
    if (!connection) throw new NotFoundError('Connection not found');
    names = [...Object.values((connection.secrets ?? {}) as Record<string, string>), ...(connection.webhookSecretEnv ? [String(connection.webhookSecretEnv)] : [])];
  } else {
    const provider = input.kind && input.provider ? providerFor(input.kind, input.provider) : undefined;
    if (!provider) throw new ValidationError('Name the kind and provider', { provider: ['Required'] });
    const code = input.code ?? 'NEW';
    names = [...describeSecrets(provider).map((s) => secretEnvName(code, s.key)), ...(provider.inbound && !provider.verifyInbound ? [secretEnvName(code, 'signingSecret')] : [])];
  }
  const company = await Company.findOne().select('tradingName legalName').lean<{ tradingName?: string; legalName?: string }>();
  const key = String(company?.tradingName ?? company?.legalName ?? 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'company';
  return { names: names.map((name) => ({ name, set: Boolean(process.env[name]) })), ...secretSetup(names, input.target, key) };
}

/* The screen */

/** Every kind, what it is connected to now, and every provider it could use with the form to set it up. */
export async function kindsStatus() {
  const connections = await Connection.find({ status: 'active' }).lean() as Plain[];
  const rules = await connectionRules();
  return Promise.all(KINDS.map(async (kind) => {
    const now = await using(kind);
    const active = now.connection;
    const kindConnections = connections.filter((c) => c.kind === kind);
    return {
      kind, ...KIND_INFO[kind],
      locked: Boolean(rules[kind]?.locked),
      allowed: rules[kind]?.providers ?? null,
      via: kind === 'rates' && !active ? 'none' : now.via,
      provider: kind === 'rates' && !active ? undefined : { key: now.provider.key, label: now.provider.label, simulated: Boolean(now.provider.simulated) },
      connectionId: active ? String(active._id) : undefined,
      connectionName: active?.name,
      lastTest: active?.lastTest, lastError: active?.lastError, lastUsedAt: active?.lastUsedAt,
      connections: kindConnections.length,
      providers: providersOf(kind).map((p) => ({
        key: p.key, label: p.label, description: p.description, simulated: Boolean(p.simulated),
        fields: describeFields(p), secrets: describeSecrets(p), inbound: Boolean(p.inbound),
        ownSignature: Boolean(p.verifyInbound), guide: p.guide ?? [], ...(p.comingSoon ? { comingSoon: p.comingSoon } : {}),
      })),
    };
  }));
}

/* Inbound calls */

/** A listener may answer what it did with the call (#136): its counts are added to the webhook's answer. */
type InboundListener = (kind: Kind, connection: Plain, result: InboundResult) => Promise<void | InboundCounts>;
const listeners: InboundListener[] = [];
/** Lets a feature act on what a service pushes, e.g. #136 keeping tracker positions on their trucks. */
export function onInbound(listener: InboundListener) { listeners.push(listener); }

/**
 * One call to a connection's webhook. Refused unless the connection is switched on, its provider takes
 * calls, and the call is signed with its signing secret within the last five minutes.
 */
async function inboundTarget(id: string) {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new NotFoundError('Not found');
  const connection = await Connection.findOne({ _id: id, enabled: true, status: 'active' }).lean() as Plain | null;
  const provider = connection && isKind(String(connection.kind)) ? providerFor(connection.kind as Kind, String(connection.provider)) : undefined;
  if (!connection || !provider?.inbound) throw new NotFoundError('Not found');
  return { connection, provider };
}

/** A service checking the address before it sends anything (Meta's GET with hub.challenge): the answer it expects. */
export async function answerHandshake(id: string, query: Record<string, string | undefined>) {
  const { connection, provider } = await inboundTarget(id);
  if (!provider.handshake) throw new NotFoundError('Not found');
  try {
    return provider.handshake(contextFor(provider, connection as never), query);
  } catch (err) {
    await recordError(connection._id, `A webhook check was refused: ${(err as Error).message}`);
    throw new UnauthorizedError((err as Error).message);
  }
}

export async function receiveInbound(id: string, headers: { timestamp?: string; signature?: string; all?: Record<string, string | undefined>; contentType?: string }, raw: Buffer) {
  const { connection, provider } = await inboundTarget(id);
  if (provider.verifyInbound) {
    // Meta and Twilio sign with their own keys; theirs is the check.
    let refused: string | undefined;
    try { refused = provider.verifyInbound(contextFor(provider, connection as never), { headers: headers.all ?? {}, raw, url: webhookUrlOf(connection._id) }); } catch (err) { refused = (err as Error).message; }
    if (refused) {
      await recordError(connection._id, `A call was refused: ${refused}`);
      throw new UnauthorizedError(refused);
    }
    return deliverInbound(connection, provider, raw, headers.contentType);
  }
  if (!connection.webhookSecretEnv) throw new NotFoundError('Not found');
  const secret = process.env[String(connection.webhookSecretEnv)];
  if (!secret) {
    await recordError(connection._id, `A call came in, but ${String(connection.webhookSecretEnv)} is not set on the server, so it can't be checked`);
    throw new UnauthorizedError('This connection cannot check signatures yet');
  }
  const refused = verifySignature(secret, headers.timestamp, headers.signature, raw);
  if (refused) {
    await recordError(connection._id, `A call was refused: ${refused}`);
    throw new UnauthorizedError(refused);
  }
  return deliverInbound(connection, provider, raw, headers.contentType);
}

/** Reads a checked call (JSON, or a form as Twilio sends) and hands what it carried to the features listening. */
async function deliverInbound(connection: Plain, provider: Provider, raw: Buffer, contentType?: string) {
  let body: unknown;
  if (contentType?.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  else {
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new ValidationError('The body is not JSON'); }
  }
  const result = await provider.inbound!(contextFor(provider, connection as never), body);
  await recordUse(connection._id);
  const counts: Required<Omit<InboundCounts, 'notes'>> = { stored: 0, duplicate: 0, unmatched: 0, rejected: 0 };
  const notes = result.note ? [result.note] : [];
  let counted = false;
  for (const listener of listeners) {
    const heard = await listener(connection.kind as Kind, connection, result);
    if (!heard) continue;
    counted = true;
    for (const k of ['stored', 'duplicate', 'unmatched', 'rejected'] as const) counts[k] += heard[k] ?? 0;
    notes.push(...(heard.notes ?? []));
  }
  return { accepted: result.accepted, ...(counted ? counts : {}), ...(notes.length ? { note: notes.join('. ') } : {}) };
}
