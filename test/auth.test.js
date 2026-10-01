import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { authFile } from '../src/paths.js';
import { normalizeCookie, loadAuth, saveAuth, setupAuth } from '../src/auth.js';

async function isolated(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smup-auth-test-'));
  const names = ['SMUP_HOME', 'SMUP_COOKIE', 'SMUP_COOKIE_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.SMUP_HOME = directory;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('cookie input accepts a complete header and rejects malformed multi-line values', () => {
  assert.equal(normalizeCookie(' Cookie: session=fake; other=value '), 'session=fake; other=value');
  for (const value of ['', 'missing-equals', 'session=fake\nHeader=value', 'session=fake\0']) {
    assert.throws(() => normalizeCookie(value), /complete/);
  }
});

test('cookie environment and file overrides follow documented priority', async t => {
  const directory = await isolated(t);
  const file = path.join(directory, 'cookie.txt');
  await writeFile(file, 'Cookie: session=from-file');
  process.env.SMUP_COOKIE_FILE = file;
  process.env.SMUP_COOKIE = 'session=from-environment';
  assert.equal((await loadAuth()).cookie, 'session=from-environment');
  delete process.env.SMUP_COOKIE;
  assert.equal((await loadAuth()).cookie, 'session=from-file');
  await writeFile(file, 'malformed');
  await assert.rejects(loadAuth(), /complete/);
});

test('saved cookie round-trips with native Windows DPAPI or private file permissions', async t => {
  await isolated(t);
  const cookie = 'session=synthetic-auth-fixture; other=fake';
  await saveAuth(cookie);
  const storedText = await readFile(authFile(), 'utf8');
  const stored = JSON.parse(storedText);
  if (process.platform === 'win32') {
    assert.equal(stored.protection, 'windows-dpapi');
    assert.doesNotMatch(storedText, /synthetic-auth-fixture|other=fake/);
    assert.equal(Object.hasOwn(stored, 'cookie'), false);
  } else {
    assert.equal(stored.protection, 'file');
    assert.equal((await stat(authFile())).mode & 0o777, 0o600);
  }
  assert.deepEqual(await loadAuth(), { cookie });
  await saveAuth('session=replaced-synthetic-fixture');
  assert.equal((await loadAuth()).cookie, 'session=replaced-synthetic-fixture');
});

test('missing, corrupt, unsupported and invalid encrypted records give recovery instructions', async t => {
  await isolated(t);
  await assert.rejects(loadAuth(), /Run smup setup/);
  for (const text of ['{', 'null', '[]', '{"protection":"other"}', '{"protection":"windows-dpapi","encrypted":42}', '{"protection":"file"}']) {
    await writeFile(authFile(), text);
    await assert.rejects(loadAuth(), /Run smup setup/);
  }
});

test('setup rejects non-interactive input without writing a cookie', async t => {
  await isolated(t);
  if (process.stdin.isTTY) return t.skip('This guard is exercised by non-interactive test runners.');
  await assert.rejects(setupAuth(), /interactive terminal/);
  await assert.rejects(readFile(authFile()), { code: 'ENOENT' });
});
