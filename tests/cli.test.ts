// The fleet CLI (#133, platform design phases 2 and 4): migrate, check, kit, and up/down with Docker. Docker itself
// is stood in for by a script that records what it was asked, so these run anywhere; the CI's kit job runs
// `fleet up` against the real Docker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { environmentSchema, profileSchema, unzip } from '../src/profile/index.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'kit');
const temp = (tag: string) => mkdtempSync(join(tmpdir(), `fleet-cli-${tag}-`));
const fleet = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/fleet.ts', ...args], {
  encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent', FLEET_ENGINE: '', ...env }, timeout: 120_000,
});
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

/** A company folder made from the kit fixture by `fleet migrate`. */
function migrated() {
  const out = temp('company');
  const r = fleet(['migrate', join(FIXTURE, 'company.json'), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}

/** A stand-in for docker: records each call (folder, PORT, arguments) and answers as a running Docker would. */
function fakeDocker() {
  const bin = temp('bin');
  const calls = join(bin, 'calls.txt');
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$PWD|$PORT|$*" >> "${calls}"\ncase "$1" in --version) echo "Docker version 27.0.0, build x";; info) echo 27.0.0;; esac\nexit 0\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}`, FLEET_UP_WAIT_MS: '1500' }, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

describe('fleet migrate, check and kit', () => {
  test('migrate writes profile.json and environments/compose.json that validate, with the files they name', () => {
    const dir = migrated();
    assert.ok(profileSchema.safeParse(readJson(join(dir, 'profile.json'))).success);
    assert.ok(environmentSchema.safeParse(readJson(join(dir, 'environments', 'compose.json'))).success);
    assert.equal(readJson(join(dir, 'profile.json')).revision, 1);
    assert.deepEqual(readFileSync(join(dir, 'files', 'logo.png')), readFileSync(join(FIXTURE, 'files', 'logo.png')));
    assert.ok(existsSync(join(dir, 'data', 'vehicles.csv')));
    // Not over a profile already there, unless asked.
    const again = fleet(['migrate', join(FIXTURE, 'company.json'), '--out', dir]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /--force/);
  });

  test('kit from the profile reproduces the zip npm run kit makes from the company file', () => {
    const dir = migrated();
    const out = temp('out');
    const fromProfile = fleet(['kit', dir, '--out', join(out, 'new')]);
    assert.equal(fromProfile.status, 0, fromProfile.stderr);
    const old = spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/kit.ts', join(FIXTURE, 'company.json'), '--out', join(out, 'old')], { encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'silent' } });
    assert.equal(old.status, 0, old.stderr);
    const a = unzip(readFileSync(join(out, 'new', 'acme-haulage-kit.zip')));
    const b = unzip(readFileSync(join(out, 'old', 'acme-haulage-kit.zip')));
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    assert.equal(a.get('acme-haulage-kit/company.json')!.toString(), b.get('acme-haulage-kit/company.json')!.toString());
  });

  test('check passes a good company, and lists what is wrong with a bad one', () => {
    const dir = migrated();
    const ok = fleet(['check', dir]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ready for compose: revision 1/);
    const profile = readJson(join(dir, 'profile.json'));
    profile.brand.files.logo = 'files/missing.png';
    profile.owner = {};
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
    const bad = fleet(['check', dir]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /owner\.email/);
  });

  test('with two environments, kit asks which one; with the name, it makes that one', () => {
    const dir = migrated();
    writeFileSync(join(dir, 'environments', 'trial.json'), JSON.stringify({ format: 2, name: 'trial', purpose: 'trial', trialEnds: '2026-11-26', target: 'compose', domain: 'trial.acme-haulage.example' }));
    const which = fleet(['kit', dir]);
    assert.equal(which.status, 1);
    assert.match(which.stderr, /--env \(compose, trial\)/);
    const out = temp('trial');
    const made = fleet(['kit', dir, '--env', 'trial', '--out', out]);
    assert.equal(made.status, 0, made.stderr);
    assert.match(unzip(readFileSync(join(out, 'acme-haulage-kit.zip'))).get('acme-haulage-kit/.env.example')!.toString(), /^COPY_PURPOSE=trial$/m);
  });

  test('an environment file that names itself differently is a problem', () => {
    const dir = migrated();
    writeFileSync(join(dir, 'environments', 'trial.json'), JSON.stringify({ format: 2, name: 'staging', purpose: 'trial', target: 'compose', domain: 'trial.acme-haulage.example' }));
    const r = fleet(['check', dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /environments\.trial\.name/);
  });
});

describe('fleet up and down with Docker', () => {
  test('a copy on this computer: the kit is written, its settings made once, and compose started as start.sh does', () => {
    const dir = migrated();
    cpSync(join(FIXTURE, 'files'), join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'environments', 'demo-local.json'), JSON.stringify({ format: 2, name: 'demo-local', purpose: 'demo', target: 'local', port: 8197 }));
    const docker = fakeDocker();
    const r = fleet(['up', dir, '--env', 'demo-local'], docker.env);
    // Nothing answers behind the stand-in, so it stops after waiting, and says so.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /didn't answer at http:\/\/localhost:8197/);
    const kit = join(dir, '.build', 'demo-local', 'kit');
    const up = docker.calls().find((c) => c.includes(' up -d --build'));
    assert.ok(up, docker.calls().join('\n'));
    assert.equal(realpathSync(up!.split('|')[0]!), realpathSync(kit), 'run in the kit folder');
    assert.equal(up!.split('|')[1], '8197', 'on its own port');
    assert.match(up!, /compose --project-name fleet-acme-haulage-local up -d --build/);
    const settings = readFileSync(join(kit, '.env'), 'utf8');
    assert.match(settings, /^JWT_SECRET=[A-Za-z0-9]{48}$/m);
    assert.match(settings, /^OWNER_PASSWORD=Fleet[A-Za-z0-9]{10}7$/m);
    assert.match(settings, /^COPY_PURPOSE=demo$/m);
    assert.ok(existsSync(join(kit, 'docker-compose.yml')) && existsSync(join(kit, 'company.json')) && existsSync(join(kit, 'files', 'logo.png')));
    // Started again, the same sign-in key: changing it would sign everyone out.
    fleet(['up', dir, '--env', 'demo-local'], docker.env);
    assert.equal(readFileSync(join(kit, '.env'), 'utf8'), settings);
    const stopped = fleet(['down', dir, '--env', 'demo-local', '--remove'], docker.env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.ok(docker.calls().some((c) => /compose --project-name fleet-acme-haulage-local down -v/.test(c)));
    assert.ok(!existsSync(join(dir, '.build', 'demo-local')), 'removed with its settings');
  });

  test('a server copy stops before starting until its secrets are filled in', () => {
    const dir = migrated();
    const docker = fakeDocker();
    const r = fleet(['up', dir, '--env', 'compose'], docker.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Fill in SMTP_PASS, CONNECTION_AT_KEY/);
    assert.ok(!docker.calls().some((c) => c.includes(' up ')), 'compose was not started');
  });

  test('a cloud environment is not run here, and a copy without Docker needs a MongoDB', () => {
    const dir = migrated();
    writeFileSync(join(dir, 'environments', 'trial.json'), JSON.stringify({ format: 2, name: 'trial', purpose: 'trial', target: 'gcp', projectId: 'acme-fleet-trial', domainMode: 'none' }));
    const cloud = fleet(['up', dir, '--env', 'trial']);
    assert.equal(cloud.status, 1);
    assert.match(cloud.stderr, /fleet kit/);
    const node = fleet(['up', dir, '--env', 'compose', '--engine', 'node']);
    assert.equal(node.status, 1);
    assert.match(node.stderr, /needs Docker/);
  });
});
