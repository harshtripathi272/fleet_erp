/** How long any outside service gets to answer before the call is given up. */
export const CALL_TIMEOUT_MS = 20_000;

/**
 * Calls an outside service and reads its JSON answer. Throws with the service's own words when it
 * refuses, so the connection's last error says what went wrong. Tests replace `globalThis.fetch`.
 */
export async function callJson<T = Record<string, unknown>>(service: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS), headers: { accept: 'application/json', ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const said = (b.message ?? b.error_message ?? b.description ?? (b.error as { message?: string } | undefined)?.message ?? b.error ?? text.slice(0, 200)) as string;
    throw new Error(`${service} answered ${res.status}: ${String(said || res.statusText)}`);
  }
  return body as T;
}

export const basicAuth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
