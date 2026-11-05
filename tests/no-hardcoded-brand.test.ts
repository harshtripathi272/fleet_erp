import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

/**
 * White-label (#71): no company's name is written into the product. Each company's name comes from its brand.
 * Allowed: comments, the sample company in sample data, and "Marichi Talks", which is a WhatsApp provider's name
 * (a connection a company may choose), not our brand.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = ['src', 'web/src', 'web/index.html', 'public/console'];
const SAMPLE = /sampleData\.ts$|sampleHistory\.ts$|phone\/samples\.ts$/;

function files(path: string): string[] {
  const full = join(ROOT, path);
  try {
    return readdirSync(full, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(path, e.name)) : /\.(tsx?|js|html|css)$/.test(e.name) ? [join(path, e.name)] : []));
  } catch {
    return [path];
  }
}

/** The file with its comments blanked out, so line numbers still match. */
const withoutComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
  .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

describe('no brand written into the product', () => {
  test('"Marichi" appears only in comments, sample data and the Marichi Talks provider', () => {
    const found: string[] = [];
    for (const file of SCAN.flatMap(files)) {
      if (SAMPLE.test(file)) continue;
      withoutComments(readFileSync(join(ROOT, file), 'utf8')).split('\n').forEach((line, i) => {
        if (/marichi/i.test(line.replace(/Marichi Talks|marichiTalks|marichi-talks|MARICHI_TALKS/g, ''))) found.push(`${relative(ROOT, join(ROOT, file))}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(found, [], `The product names a company in code:\n${found.join('\n')}`);
  });
});
