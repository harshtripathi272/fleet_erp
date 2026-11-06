import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { KINDS, type Kind, type Provider, type ProviderContext, type SecretSpec } from './types.js';

const providers = new Map<string, Provider>();
const id = (kind: Kind, key: string) => `${kind}:${key}`;

/** Adds a provider (each file in ./providers calls this). A test may replace one with a fake of the same key. */
export function registerProvider<K extends Kind>(provider: Provider<K>) {
  providers.set(id(provider.kind, provider.key), provider as unknown as Provider);
}

export const providerFor = (kind: Kind, key: string) => providers.get(id(kind, key));
export const providersOf = (kind: Kind) => [...providers.values()].filter((p) => p.kind === kind).sort((a, b) => Number(b.simulated ?? false) - Number(a.simulated ?? false) || a.label.localeCompare(b.label));
/** Every kind has one: what runs while nothing real is connected. */
export const simulatedProvider = (kind: Kind) => providersOf(kind).find((p) => p.simulated);
export const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

/**
 * Names a connection may give for the environment variable (or Secret Manager entry mounted as one) that
 * holds a secret. Limited so a connection can never point at the server's own secrets (JWT_SECRET,
 * MONGODB_URI, ...) and send them to a service of its choosing.
 */
export const SECRET_ENV = /^(SMTP_PASS|RATE_FEED_API_KEY|MESSAGING_[A-Z0-9_]{1,50}|CONNECTION_[A-Z0-9_]{1,50})$/;
export const SECRET_ENV_HINT = 'SMTP_PASS, RATE_FEED_API_KEY, or a name starting with CONNECTION_, e.g. CONNECTION_TWILIO_TOKEN';

/**
 * The server setting that holds a connection's secret, made from its code and the secret's key (#98), so
 * nobody types it: connection WA, secret accessToken → CONNECTION_WA_ACCESS_TOKEN.
 */
export function secretEnvName(code: string, key: string): string {
  const part = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `CONNECTION_${`${part(code) || 'X'}_${part(key)}`.slice(0, 50).replace(/_+$/, '')}`;
}

export interface ConnectionLike { _id?: unknown; settings?: Record<string, unknown>; secrets?: Record<string, string> }

/** What a provider is handed for one connection. Secret values are read from the environment when used. */
export function contextFor(provider: Provider, connection?: ConnectionLike): ProviderContext {
  const names = connection?.secrets ?? {};
  return {
    settings: connection?.settings ?? {},
    connectionId: connection?._id ? String(connection._id) : undefined,
    secret(key: string) {
      const spec = provider.secrets?.find((s) => s.key === key);
      const name = names[key];
      if (!name) {
        if (spec?.required) throw new Error(`No server setting is named for ${spec.label}`);
        return undefined;
      }
      const value = process.env[name];
      if (!value && spec?.required !== false) throw new Error(`${name} is not set on the server`);
      return value || undefined;
    },
  };
}

/** Error text with every secret value of the connection taken out, before it is stored or shown. */
export function scrub(message: string, connection?: ConnectionLike & { webhookSecretEnv?: string }): string {
  let out = message.slice(0, 500);
  const names = [...Object.values(connection?.secrets ?? {}), connection?.webhookSecretEnv].filter(Boolean) as string[];
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 4) out = out.split(value).join('[hidden]');
  }
  return out;
}

/** A field of a provider's form, as the Connections screen draws it. */
export interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  type: 'string' | 'number' | 'boolean' | 'choice';
  required: boolean;
  choices?: Array<{ value: string; label: string }>;
  default?: unknown;
  min?: number;
  max?: number;
}

const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/\b(Url|Id|Api|Sms|Smtp)\b/gi, (w) => ({ url: 'URL', id: 'ID', api: 'API', sms: 'SMS', smtp: 'SMTP' } as Record<string, string>)[w.toLowerCase()] ?? w);

/** A provider's fields, read from its zod schema, labelled and hinted from the provider. */
export function describeFields(provider: Provider): FieldSpec[] {
  const schema = z.toJSONSchema(provider.fields, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  return Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const choices = Array.isArray(p.enum) ? (p.enum as string[]) : undefined;
    const type = choices ? 'choice' : p.type === 'integer' || p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string';
    return {
      key,
      label: provider.labels?.[key] ?? words(key),
      ...(provider.hints?.[key] ? { hint: provider.hints[key] } : {}),
      type,
      required: (schema.required ?? []).includes(key) && p.default === undefined,
      ...(choices ? { choices: choices.map((value) => ({ value, label: provider.labels?.[`${key}.${value}`] ?? words(value) })) } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(typeof p.minimum === 'number' ? { min: p.minimum } : {}),
      ...(typeof p.maximum === 'number' ? { max: p.maximum } : {}),
    } satisfies FieldSpec;
  });
}

export const describeSecrets = (provider: Provider): SecretSpec[] => provider.secrets ?? [];

/* Inbound webhooks: one URL per connection, signed with the connection's own secret. */

/** How far a signed call's timestamp may be from now, so a captured call can't be replayed later. */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** The signature a sender puts in `X-Signature`: HMAC-SHA256 of "<timestamp>.<body>", hex, after "sha256=". */
export function signBody(secret: string, timestamp: string, body: Buffer | string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

/** Checks a call's signature and timestamp. Says why when it fails, for the connection's last error. */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: Buffer, now = Date.now()): string | undefined {
  if (!timestamp || !signature) return 'The call is not signed (X-Signature-Timestamp and X-Signature are needed).';
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > SIGNATURE_WINDOW_SECONDS) return 'The signature timestamp is missing or more than five minutes away from now.';
  const expected = Buffer.from(signBody(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'The signature does not match.';
  return undefined;
}
