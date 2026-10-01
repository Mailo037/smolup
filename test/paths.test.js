import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { authFile, configDirectory, environmentValue, jobsDirectory, stateDirectory } from '../src/paths.js';
import { configFile, emptyConfig, loadConfig } from '../src/config.js';
import { loadAuth } from '../src/auth.js';
import { createJob, loadJob } from '../src/jobs.js';

async function isolated(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(temporaryRoot, 'smolup-paths-test-')));
  assert.equal(path.dirname(directory), temporaryRoot);
  const names = ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'SMOLUP_HOME', 'SMOP_HOME', 'SMUP_HOME', 'SMOLUP_CONFIG', 'SMOP_CONFIG', 'SMUP_CONFIG',
    'SMOLUP_COOKIE', 'SMOP_COOKIE', 'SMUP_COOKIE', 'SMOLUP_COOKIE_FILE', 'SMOP_COOKIE_FILE', 'SMUP_COOKIE_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = path.join(directory, 'config');
  process.env.LOCALAPPDATA = process.env.XDG_CACHE_HOME = path.join(directory, 'state');
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('current environment names take priority while legacy names remain supported', async t => {
  const root = await isolated(t);
  assert.equal(environmentValue('COOKIE', { SMUP_COOKIE: 'legacy' }), 'legacy');
  assert.equal(environmentValue('COOKIE', { SMOP_COOKIE: 'previous', SMUP_COOKIE: 'legacy' }), 'previous');
  assert.equal(environmentValue('COOKIE', { SMOLUP_COOKIE: 'current', SMOP_COOKIE: 'previous', SMUP_COOKIE: 'legacy' }), 'current');
  assert.equal(environmentValue('COOKIE', { SMOLUP_COOKIE: '', SMOP_COOKIE: 'previous', SMUP_COOKIE: 'legacy' }), '');
  process.env.SMUP_HOME = path.join(root, 'legacy-home');
  assert.equal(configDirectory(), process.env.SMUP_HOME);
  assert.equal(stateDirectory(), path.join(process.env.SMUP_HOME, 'state'));
  process.env.SMOP_HOME = path.join(root, 'previous-home');
  assert.equal(configDirectory(), process.env.SMOP_HOME);
  assert.equal(stateDirectory(), path.join(process.env.SMOP_HOME, 'state'));
  process.env.SMOLUP_HOME = path.join(root, 'current-home');
  assert.equal(configDirectory(), process.env.SMOLUP_HOME);
  assert.equal(stateDirectory(), path.join(process.env.SMOLUP_HOME, 'state'));
  process.env.SMUP_CONFIG = path.join(root, 'legacy-config.json');
  await writeFile(process.env.SMUP_CONFIG, JSON.stringify({ ...emptyConfig(), defaults: { rename: 'Legacy config' } }));
  assert.equal(configFile(), process.env.SMUP_CONFIG);
  assert.equal((await loadConfig()).defaults.rename, 'Legacy config');
  process.env.SMOP_CONFIG = path.join(root, 'previous-config.json');
  await writeFile(process.env.SMOP_CONFIG, JSON.stringify({ ...emptyConfig(), defaults: { rename: 'Previous config' } }));
  assert.equal(configFile(), process.env.SMOP_CONFIG);
  assert.equal((await loadConfig()).defaults.rename, 'Previous config');
  process.env.SMOLUP_CONFIG = path.join(root, 'current-config.json');
  await writeFile(process.env.SMOLUP_CONFIG, JSON.stringify({ ...emptyConfig(), defaults: { rename: 'Current config' } }));
  assert.equal(configFile(), process.env.SMOLUP_CONFIG);
  assert.equal((await loadConfig()).defaults.rename, 'Current config');
});

test('existing legacy directories preserve configuration, saved cookies and upload jobs', async t => {
  const root = await isolated(t);
  const legacyConfig = path.join(root, 'config', 'smup');
  const legacyState = path.join(root, 'state', 'smup');
  await mkdir(legacyConfig, { recursive: true });
  await mkdir(legacyState, { recursive: true });
  await writeFile(path.join(legacyConfig, 'config.json'), JSON.stringify({ ...emptyConfig(), defaults: { visibility: 'public' } }));
  await writeFile(path.join(legacyConfig, 'auth.json'), JSON.stringify({ protection: 'file', cookie: 'session=synthetic-legacy-account' }));
  assert.equal(configDirectory(), legacyConfig);
  assert.equal(stateDirectory(), legacyState);
  assert.equal(authFile(), path.join(legacyConfig, 'auth.json'));
  assert.equal(jobsDirectory(), path.join(legacyState, 'jobs'));
  assert.equal((await loadConfig()).defaults.visibility, 'public');
  assert.equal((await loadAuth()).cookie, 'session=synthetic-legacy-account');
  const job = await createJob('legacy-video.mp4', 12);
  assert.equal((await loadJob(job.id)).source, 'legacy-video.mp4');
  assert.equal(job.directory, path.join(legacyState, 'jobs', job.id));

  const previousConfig = path.join(root, 'config', 'smop');
  const previousState = path.join(root, 'state', 'smop');
  await mkdir(previousConfig);
  await mkdir(previousState);
  await writeFile(path.join(previousConfig, 'config.json'), JSON.stringify({ ...emptyConfig(), defaults: { rename: 'Previous config' } }));
  await writeFile(path.join(previousConfig, 'auth.json'), JSON.stringify({ protection: 'file', cookie: 'session=synthetic-previous-account' }));
  assert.equal(configDirectory(), previousConfig);
  assert.equal(stateDirectory(), previousState);
  assert.equal((await loadConfig()).defaults.rename, 'Previous config');
  assert.equal((await loadAuth()).cookie, 'session=synthetic-previous-account');
  const previousJob = await createJob('previous-video.mp4', 4);
  assert.equal((await loadJob(previousJob.id)).source, 'previous-video.mp4');
  assert.equal(previousJob.directory, path.join(previousState, 'jobs', previousJob.id));

  const currentConfig = path.join(root, 'config', 'smolup');
  const currentState = path.join(root, 'state', 'smolup');
  await mkdir(currentConfig);
  await mkdir(currentState);
  assert.equal(configDirectory(), currentConfig);
  assert.equal(stateDirectory(), currentState);
  assert.deepEqual(await loadConfig(), emptyConfig());
});

test('a new installation uses smolup directories on every supported platform', async t => {
  const root = await isolated(t);
  assert.equal(configDirectory(), path.join(root, 'config', 'smolup'));
  assert.equal(stateDirectory(), path.join(root, 'state', 'smolup'));
});
