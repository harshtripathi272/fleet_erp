/**
 * Calls to the Marichi Fleet API through the Vite proxy (`/api` → the API). Keeps the token pair,
 * refreshes once on a 401 (one refresh shared by parallel requests, since refresh tokens are single
 * use), retries, and signs out when the refresh fails.
 */

export interface Tokens {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

export interface Page<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasNextPage: boolean };
}

const KEY = "marichi.fleet.session";
const listeners = new Set<() => void>();

function read(): Tokens | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}
let tokens: Tokens | null = read();

export const hasSession = () => Boolean(tokens?.refreshToken);
export const onSignedOut = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function setTokens(next: Tokens | null) {
  tokens = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the session lasts for this tab */
  }
  if (!next) listeners.forEach((fn) => fn());
}

/** Another tab signed in, refreshed or signed out. */
window.addEventListener("storage", (event) => {
  if (event.key !== KEY) return;
  tokens = read();
  if (!tokens) listeners.forEach((fn) => fn());
});

let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = tokens?.refreshToken;
    if (!refreshToken) return false;
    const res = await fetch("/api/v1/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }) });
    if (!res.ok) {
      // A tab that refreshed first already stored a new pair.
      const stored = read();
      if (stored && stored.refreshToken !== refreshToken) {
        tokens = stored;
        return true;
      }
      setTokens(null);
      return false;
    }
    setTokens((await res.json()).data as Tokens);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;
export interface Options {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  /** Sign-in calls send no token and never refresh. */
  anonymous?: boolean;
  /** Extra headers, e.g. `Idempotency-Key` for a request the driver app may send twice. */
  headers?: Record<string, string>;
}

function url(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return `/api/v1${path}${qs ? `?${qs}` : ""}`;
}

async function send(path: string, options: Options) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (!options.anonymous && tokens?.accessToken) headers.Authorization = `Bearer ${tokens.accessToken}`;
  return fetch(url(path, options.query), { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

/** The whole response envelope: `{ success, data, meta?, message? }`. */
export async function request<T = unknown>(path: string, options: Options = {}): Promise<{ data: T; meta?: Page<unknown>["meta"]; message?: string }> {
  let res = await send(path, options);
  if (res.status === 401 && !options.anonymous && (await refresh())) res = await send(path, options);
  if (res.status === 204) return { data: undefined as T };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !options.anonymous) setTokens(null);
    throw new ApiError(messageOf(body, res.statusText), res.status, body.error?.code, body.error?.details);
  }
  return body;
}

export const api = async <T = unknown>(path: string, options: Options = {}) => (await request<T>(path, options)).data;

/** A signed-in request with a raw body or a binary answer (uploads and downloads), refreshed like the rest. */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = () => fetch(`/api/v1${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(tokens?.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {}) } });
  let res = await go();
  if (res.status === 401 && (await refresh())) res = await go();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) setTokens(null);
    throw new ApiError(messageOf(body, res.statusText), res.status, body.error?.code, body.error?.details);
  }
  return res;
}

/** Every page of a list, for the reference data the desks keep in memory. */
export async function all<T>(path: string, query: Query = {}): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 200; page += 1) {
    const res = await request<T[]>(path, { query: { ...query, page, limit: 100 } });
    out.push(...res.data);
    if (!res.meta?.hasNextPage) break;
  }
  return out;
}

/** The API's plain sentence, plus the first field problem when validation failed. */
function messageOf(body: { error?: { message?: string; details?: unknown } }, fallback: string) {
  const message = body.error?.message ?? fallback;
  const first = firstProblem(body.error?.details);
  if (!first) return message;
  // A generic sentence ("Validation failed", "Invalid data fields") gives way to every field's problem.
  if (message === "Validation failed" || /^Invalid .*fields?$/.test(message)) return allProblems(body.error?.details).join(". ") || first;
  // Add the field's problem only when the sentence does not already name that field.
  const field = first.split(/:| is required/)[0]!.toLowerCase();
  return !message.toLowerCase().includes(field) && message.length < 40 ? `${message}: ${first}` : message;
}

/** Every field problem, one sentence each ("Driver is required", "Expiry date is required"). */
function allProblems(details: unknown, key = ""): string[] {
  if (!details || typeof details !== "object") return [];
  if (Array.isArray(details)) return typeof details[0] === "string" ? [key ? plain(key, details[0]) : details[0]] : [];
  return Object.entries(details as Record<string, unknown>).flatMap(([k, v]) =>
    k === "currentVersion" || k === "usage" ? [] : ["body", "data", "formErrors", "fieldErrors", "references"].includes(k) ? allProblems(v) : typeof v === "string" ? [plain(k, v)] : allProblems(v, k));
}

function firstProblem(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  if (Array.isArray(details)) return typeof details[0] === "string" ? details[0] : firstProblem(details[0]);
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (key === "currentVersion" || key === "usage") continue;
    if (typeof value === "string") return value;
    const nested = firstProblem(value);
    if (nested) return ["body", "data", "formErrors", "fieldErrors", "references"].includes(key) ? nested : plain(key, nested);
  }
  return undefined;
}

/** "code" + Zod's "Invalid input: expected string, received undefined" reads as "Code is required". */
function plain(key: string, problem: string) {
  if (/^\d+$/.test(key)) return problem;
  const name = key.replace(/Id(s)?$/, "$1").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/^./, (c) => c.toUpperCase());
  if (/received (undefined|null)$/.test(problem) || problem === "Required") return `${name} is required`;
  return `${name}: ${problem.replace(/^Invalid input: /, "")}`;
}
