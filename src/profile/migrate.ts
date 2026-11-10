import type { z } from 'zod';
import { ENVIRONMENT_FORMAT, type Environment, type Purpose, deployOf, environmentSchema } from './environment.js';
import { COMPANY_FILE_FORMAT, type CompanyFile, PROFILE_FORMAT, type Profile, companyFileSchema, profileSchema } from './schema.js';

/**
 * Moving between the formats (platform design §5.3). Format 1 is one company file with where it runs inside
 * it; format 2 is a profile (the company) and one environment file per copy. One function per step, so a later
 * format 3 adds one more. Studio migrates a file when it is imported; the Runtime reads either.
 */

export interface Problem { path: string; message: string }
export const problemsOf = (error: z.ZodError, prefix: string[] = []): Problem[] => error.issues.map((i) => ({ path: [...prefix, ...i.path.map(String)].join('.') || '(file)', message: i.message }));

/** The environment a format-1 file's `deploy` becomes: named after its target, or demo-local for a demonstration on this computer. */
export const environmentNameFor = (file: Pick<CompanyFile, 'deploy' | 'purpose'>) => (file.deploy.target === 'local' ? (file.purpose === 'demo' ? 'demo-local' : 'local') : file.deploy.target);
/** A format-1 purpose as a copy's purpose: a demonstration stays one; a real company's copy is production (a trial is a choice made later). */
export const purposeFor = (purpose: CompanyFile['purpose']): Purpose => (purpose === 'demo' ? 'demo' : 'production');

/** Format 1 → 2: everything except `deploy` and `purpose` is the profile, at revision 1; those two are its environment. */
export function migrate1to2(file: CompanyFile): { profile: Profile; environment: Environment } {
  const { format: _format, purpose, deploy, ...sections } = file;
  return {
    profile: profileSchema.parse({ ...sections, format: PROFILE_FORMAT, revision: 1 }),
    environment: environmentSchema.parse({ format: ENVIRONMENT_FORMAT, name: environmentNameFor(file), purpose: purposeFor(purpose), ...deploy }),
  };
}

/**
 * A profile and one of its environments as the single company file the kit and the apply have always worked on.
 * A kit still carries this as company.json, so the deploy scripts and copies already running read what they did.
 */
export function companyFileOf(profile: Profile, environment: Environment): CompanyFile {
  const { format: _format, revision: _revision, appVersion: _appVersion, vendor: _vendor, ...sections } = profile;
  return companyFileSchema.parse({ ...sections, format: COMPANY_FILE_FORMAT, purpose: environment.purpose === 'demo' ? 'demo' : 'real', deploy: deployOf(environment) });
}

/**
 * Where a running copy is, when it applies a profile with no environment file beside it: what kind of copy it is
 * comes from its own settings (COPY_PURPOSE), and where it runs doesn't matter to applying the company.
 */
export const thisCopy = (purpose: Purpose): Environment => environmentSchema.parse({ format: ENVIRONMENT_FORMAT, name: 'this-copy', purpose, target: 'local' });

export type Read =
  | { ok: true; format: 1 | 2; profile: Profile; environment?: Environment; file?: CompanyFile }
  | { ok: false; format?: number; problems: Problem[] };

/**
 * Reads a company file of either format: format 1 is checked as it is and migrated; format 2 is checked as a
 * profile, with its environment if one is given. Each problem names its place in the file.
 */
export function readAny(json: unknown, environment?: unknown): Read {
  const format = json && typeof json === 'object' ? (json as { format?: unknown }).format : undefined;
  if (format === COMPANY_FILE_FORMAT) {
    const parsed = companyFileSchema.safeParse(json);
    if (!parsed.success) return { ok: false, format: 1, problems: problemsOf(parsed.error) };
    return { ok: true, format: 1, file: parsed.data, ...migrate1to2(parsed.data) };
  }
  if (format === PROFILE_FORMAT) {
    const parsed = profileSchema.safeParse(json);
    const env = environment === undefined ? undefined : environmentSchema.safeParse(environment);
    const problems = [...(parsed.success ? [] : problemsOf(parsed.error)), ...(env && !env.success ? problemsOf(env.error, ['environment']) : [])];
    if (!parsed.success || (env && !env.success)) return { ok: false, format: 2, problems };
    return { ok: true, format: 2, profile: parsed.data, environment: env?.data };
  }
  return { ok: false, format: typeof format === 'number' ? format : undefined, problems: [{ path: 'format', message: format === undefined ? 'Not a company file: it has no format (1 for a company file, 2 for a profile)' : `Format ${String(format)} isn't known: this app reads formats 1 and 2` }] };
}
