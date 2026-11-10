import type { Environment } from './environment.js';
import { buildKit, checkKit, kitName } from './kit.js';
import { type Problem, companyFileOf } from './migrate.js';
import type { CompanyFile, Profile } from './schema.js';

/**
 * Checking a profile for one of its environments, and making that environment's kit (platform design §5.6, step 2).
 * The kit is the one `npm run kit` has always made from a format-1 file: the same files, the same company.json.
 */

/** The files a profile names, which a kit carries: its brand's images, its spreadsheets and its snapshot. */
export const namedFiles = (profile: Pick<Profile, 'brand' | 'data'>) =>
  [...Object.values(profile.brand.files), ...profile.data.files.map((f) => f.file), profile.data.snapshot].filter((n): n is string => Boolean(n));

/** A problem a kit check finds, with a format-1 path (deploy.domain) put where it is in format 2 (environments.trial.domain). */
const placed = (environment: Environment) => (text: string): Problem => {
  const at = text.indexOf(': ');
  const path = text.slice(0, at);
  return { path: path === 'deploy' || path.startsWith('deploy.') ? `environments.${environment.name}${path.slice('deploy'.length)}` : path, message: text.slice(at + 2) };
};

/** Problems that stop this environment's kit being made, each with its place. Empty when it can be made. */
export function checkProfile(profile: Profile, environment: Environment, attachments: Map<string, Buffer>): Problem[] {
  return checkKit(companyFileOf(profile, environment), attachments).map(placed(environment));
}

/** The kit for one environment, or the problems that stop it. Only the files the profile names go in. */
export function profileKit(profile: Profile, environment: Environment, attachments: Map<string, Buffer>): { problems: Problem[]; zip?: Buffer; name?: string; file?: CompanyFile } {
  const file = companyFileOf(profile, environment);
  const problems = checkKit(file, attachments).map(placed(environment));
  if (problems.length) return { problems };
  const named = new Set(namedFiles(profile));
  const carried = new Map([...attachments].filter(([path]) => named.has(path)));
  return { problems: [], zip: buildKit(file, carried, { purpose: environment.purpose, trialEnds: environment.trialEnds }), name: kitName(file), file };
}
