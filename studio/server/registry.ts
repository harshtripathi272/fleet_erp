import { type Request, Router } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companyColumns, importableMaster, templateCsv } from '../../src/core/masters/import.js';
import { blankLayout, type Layout } from '../../src/core/masters/layout.js';
import { listMasters, refsOf } from '../../src/core/masters/registry.js';
import type { DynamicField } from '../../src/core/masters/dynamicFields.js';
import { AREAS } from '../../src/modules/company/areaList.js';
import { workspace } from '../../src/modules/company/workspace.js';
import { kindsFromCode } from '../../src/modules/connections/connections.service.js';
import { describeMasters } from '../../src/modules/meta/meta.service.js';
import { systemRoles } from '../../src/modules/roles/roles.service.js';
import { ratesPreview } from '../../src/modules/setup/setup.service.js';
import { TARGETS, TARGET_FIELDS, TARGET_LABEL, TARGET_NEEDS, TARGET_STATE, TESTED_TARGETS, companyFileSchema, deployGuide, problemsOf, readCsv } from '../../src/profile/index.js';
import type { Profiles } from './profiles.js';
import { DRAFT_FILE } from './workspace.js';

/**
 * What the set-up's steps ask the company app for, answered without a database (#133). The steps moved into
 * Studio as they were, and still call /api/v1/meta/masters, /meta/workspace, /roles, /connection-kinds and the
 * rest; Studio answers each from the app's own code: every master, area, role, word and service as a new
 * company starts with them. Where a step needs the company it is on (a spreadsheet, a template), the page names
 * it in the X-Fleet-Company header.
 */
type Raw = Record<string, any>;
const ok = (data: unknown) => ({ success: true, data });

export function registryRouter(profiles: Profiles) {
  const router = Router();

  /** The profile the page is on: its unsaved changes if there are any, else as saved. */
  const profileOf = (req: Request): { key?: string; profile?: Raw } => {
    const key = req.get('x-fleet-company');
    if (!key || !profiles.ws.has(key)) return {};
    const draftPath = join(profiles.ws.dir(key), DRAFT_FILE);
    const draft = existsSync(draftPath) ? (JSON.parse(readFileSync(draftPath, 'utf8')) as { profile?: Raw }).profile : undefined;
    return { key, profile: draft ?? profiles.rawProfile(key) };
  };
  const areasOf = (profile?: Raw) => new Set<string>((profile?.areas as string[] | undefined) ?? AREAS.filter((a) => a.defaultOn || ('always' in a && a.always)).map((a) => a.key));

  router.get('/meta/areas', (req, res) => {
    const on = areasOf(profileOf(req).profile);
    res.json(ok(AREAS.map((a) => ({ ...a, on: on.has(a.key), masters: listMasters().filter((d) => d.module === a.key).map((d) => d.key) }))));
  });
  // The defaults, with every area's stages and screens: the step shows the profile's own changes over them.
  router.get('/meta/workspace', async (_req, res) => res.json(ok(await workspace({ company: null, on: new Set(AREAS.map((a) => a.key)) }))));
  router.get('/meta/masters', async (_req, res) => res.json(ok(await describeMasters(undefined, { allAreas: true, fromCode: true }))));
  router.get('/setup-kit/masters', async (_req, res) => res.json(ok(await describeMasters(undefined, { allAreas: true, fromCode: true }))));
  router.get('/roles', (_req, res) => {
    res.json(ok(systemRoles().map((r) => ({ ...r, id: r.key, isSystem: true, status: 'active' }))));
  });
  router.get('/connection-kinds', (_req, res) => res.json(ok(kindsFromCode())));
  router.post('/connections/test-draft', (_req, res) => {
    res.status(409).json({ success: false, error: { code: 'NOT_HERE', message: "Studio holds no keys, so it can't try a service. Try it on the company's copy once it runs: Masters → Connections." } });
  });
  /** The lists a field can draw on: the ones this profile brings. */
  router.get('/lists', (req, res) => {
    const lists = ((profileOf(req).profile?.masters?.lists ?? []) as Raw[]);
    res.json({ ...ok(lists.map((l) => ({ ...l, id: String(l.code), status: 'active' }))), meta: { page: 1, limit: 100, total: lists.length, totalPages: 1, hasNextPage: false } });
  });

  /** A master's shape as this profile has it: its layout and its own fields, from the file rather than a database. */
  const shapeOf = (profile: Raw | undefined, master: string): { layout: Layout; fields: DynamicField[] } => {
    const l = ((profile?.masters?.layouts ?? []) as Raw[]).find((x) => x.entity === master);
    const layout: Layout = l ? { ...blankLayout(master), master: l.master ?? {}, sections: l.sections ?? [], fields: l.fields ?? [], choices: l.choices ?? [] } : blankLayout(master);
    const fields = ((profile?.masters?.fields ?? []) as Raw[]).filter((f) => f.entity === master) as unknown as DynamicField[];
    return { layout, fields };
  };
  router.get('/meta/import/:master/template', async (req, res) => {
    const def = importableMaster(String(req.params.master));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.key}-template.csv"`);
    res.send(`﻿${await templateCsv(def, shapeOf(profileOf(req).profile, def.key))}`);
  });

  /**
   * A spreadsheet checked against the master's columns: the required ones are there and filled in on each row.
   * Whether a row's links (a truck's make, a driver's licence class) find their records can only be checked by
   * the copy, against its data, so the answer says the rows are checked again there.
   */
  router.post('/setup-kit/check-sheet', async (req, res) => {
    const { key, profile } = profileOf(req);
    const { master, path } = req.body as { master: string; path: string };
    const def = importableMaster(master);
    if (!key) { res.json(ok({ rows: 0, ready: 0, exists: 0, problems: [], checkedHere: 'columns' })); return; }
    const file = profiles.ws.attachmentPath(key, path);
    if (!existsSync(file)) { res.json(ok({ rows: 0, ready: 0, exists: 0, problems: [], checkedHere: 'columns' })); return; }
    const rows = readCsv(readFileSync(file, 'utf8'));
    const columns = await companyColumns(def, shapeOf(profile, def.key));
    const header = new Set(Object.keys(rows[0] ?? {}).map((h) => h.replace(/\s*\*$/, '').trim().toLowerCase()));
    const named = (c: { label: string; aliases: string[]; path: string }) => [c.label, ...c.aliases, c.path].map((n) => n.toLowerCase()).find((n) => header.has(n));
    const problems: { row: number; column: string; message: string }[] = [];
    const required = columns.filter((c) => c.required);
    for (const c of required) if (rows.length && !named(c)) problems.push({ row: 1, column: c.label, message: 'This column is needed and is not in the sheet' });
    let ready = 0;
    rows.forEach((row, i) => {
      const cells = new Map(Object.entries(row).map(([k, v]) => [k.replace(/\s*\*$/, '').trim().toLowerCase(), v]));
      const missing = required.filter((c) => { const n = named(c); return n && !cells.get(n); });
      for (const c of missing) problems.push({ row: i + 2, column: c.label, message: 'Needs a value' });
      if (!missing.length) ready += 1;
    });
    res.json(ok({ rows: rows.length, ready, exists: 0, problems: problems.slice(0, 200), problemCount: problems.length, checkedHere: 'columns' }));
  });

  router.post('/setup-kit/rates-preview', async (req, res) => res.json(ok(await ratesPreview(req.body as { provider: string; base: string; codes: string[] }))));

  /**
   * The deploy guide for one environment: the page sends the profile with the environment's settings in
   * `deploy` and what kind of copy it is in `environment`, the shape the guide's step has always sent.
   */
  router.post('/setup-kit/guide', (req, res) => {
    const { file } = req.body as { file: Raw };
    const { environment, revision: _r, appVersion: _a, vendor: _v, ...rest } = (file ?? {}) as Raw;
    const purpose = environment?.purpose ?? 'demo';
    const parsed = companyFileSchema.safeParse({ ...rest, format: 1, purpose: purpose === 'demo' ? 'demo' : 'real' });
    if (!parsed.success) { res.json(ok({ problems: problemsOf(parsed.error) })); return; }
    res.json(ok({ problems: [], ...deployGuide(parsed.data, { purpose, trialEnds: environment?.trialEnds }) }));
  });

  /** The targets and the masters a spreadsheet can fill: what the set-up's steps call their options. */
  router.get('/studio/options', (_req, res) => {
    res.json(ok({
      targets: TARGETS.map((key) => ({ key, label: TARGET_LABEL[key], tested: TESTED_TARGETS.includes(key), state: TARGET_STATE[key], needs: TARGET_NEEDS[key], fields: TARGET_FIELDS[key] })),
      masters: listMasters().filter((d) => !d.managed?.create).map((d) => ({
        key: d.key, label: d.label, group: d.group,
        // What must already be there, so spreadsheets can be put in the right order.
        needs: [...new Set(refsOf(d).filter((r) => r.path !== 'branchIds').map((r) => r.target))].filter((t) => t !== d.key),
      })),
    }));
  });

  return router;
}
