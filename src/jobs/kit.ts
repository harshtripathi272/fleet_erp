/**
 * The company kit (#76):  npm run kit -- companies/acme/company.json [--out <folder>]
 *
 * Checks a company file and the files it names (next to it: files/, data/), then writes <company>-kit.zip
 * into the company file's folder, or --out. Exit code 1, with every problem listed, when it can't be built.
 * Needs no database: it reads only the files.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// The masters' definitions, so a data file's master can be checked.
import '../app.js';
import { readCompanyFile } from '../modules/setup/apply.js';
import { buildKit, checkKit, kitName } from '../modules/setup/kit.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const path = args.find((a, i) => !a.startsWith('--') && i !== outAt + 1);
if (!path) {
  console.error('Usage: npm run kit -- <company.json> [--out <folder>]');
  process.exit(1);
}

try {
  const { file } = await readCompanyFile(resolve(path));
  const dir = dirname(resolve(path));
  const attachments = new Map<string, Buffer>();
  const named = [...Object.values(file.brand.files).filter((f): f is string => Boolean(f)), ...file.data.files.map((f) => f.file)];
  for (const name of named) if (existsSync(join(dir, name))) attachments.set(name, readFileSync(join(dir, name)));
  const problems = checkKit(file, attachments);
  if (problems.length) {
    console.error(`The kit was not built:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  const target = join(out ? resolve(out) : dir, kitName(file));
  writeFileSync(target, buildKit(file, attachments));
  console.log(`Wrote ${target}: ${file.company.legalName}, for ${file.deploy.target}. Next: README.md inside it.`);
  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
