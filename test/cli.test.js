import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { createJob, loadJob, saveJob } from '../src/jobs.js';
import { configCommand, presetCommand } from '../src/config.js';
import { fingerprint } from '../src/uploader.js';

const ID = '22749640277360641';
const video = extra => ({ id: ID, title: 'Existing title', description: 'Original description', visibility: 'private',
  status: 'ready', durationSeconds: 42, sizeBytes: 500, viewsCount: 12, likesCount: 3, commentsCount: 1, ...extra });

async function isolatedHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smolup-cli-test-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  const names = ['SMOLUP_HOME', 'SMOLUP_CONFIG', 'SMOLUP_COOKIE', 'SMOLUP_COOKIE_FILE', 'SMOP_HOME', 'SMUP_HOME', 'SMOP_CONFIG', 'SMUP_CONFIG', 'SMOP_COOKIE', 'SMUP_COOKIE', 'SMOP_COOKIE_FILE', 'SMUP_COOKIE_FILE'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.SMOLUP_HOME = directory;
  for (const name of names.slice(1)) delete process.env[name];
  t.after(async () => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function stream() {
  const chunks = [];
  return { isTTY: true, columns: 150, write(chunk) { chunks.push(String(chunk)); }, get text() { return chunks.join(''); } };
}

async function invoke(args, api) {
  const stdout = stream(), stderr = stream();
  const exitCode = await main([...args, '--json'], { stdout, stderr, api });
  assert.equal(stdout.text.trim().split('\n').length, 1, 'stdout contains exactly one result record');
  assert.doesNotMatch(stdout.text + stderr.text, /\x1b/, 'JSON mode contains no ANSI escapes');
  const result = JSON.parse(stdout.text);
  assert.equal(result.schemaVersion, 1);
  return { exitCode, result, stdout: stdout.text, stderr: stderr.text };
}

function mockApi(initial = video()) {
  let current = structuredClone(initial);
  const calls = [];
  return {
    calls,
    async checkAuth() { calls.push(['auth']); return { id: '123', name: 'Account' }; },
    async listVideos(filters) { calls.push(['list', structuredClone(filters)]); return { total: 1, items: [current] }; },
    async getVideo(id) { calls.push(['get', id]); return structuredClone(current); },
    async analytics(id, days) { calls.push(['analytics', id, days]); return { views: 22, points: [{ date: '2026-10-01', views: 2 }] }; },
    async metadata(id, fields) { calls.push(['patch', id, structuredClone(fields)]); current = { ...current, ...fields }; return structuredClone(current); },
    async createDraft() { throw new Error('No new draft should be created by these integration tests'); },
    get current() { return current; },
  };
}

async function readyJob(metadata) {
  const job = await createJob('original.mp4', 0);
  job.prepared = path.join(job.directory, 'prepared.mp4');
  await writeFile(job.prepared, Buffer.from('prepared local video fixture'));
  job.sha256 = await fingerprint(job.prepared);
  job.videoId = ID;
  job.stage = 'processing';
  if (metadata) job.metadata = metadata;
  await saveJob(job);
  return job;
}

test('list, info and analytics return one clean JSON result with account-backed values', async t => {
  await isolatedHome(t);
  const api = mockApi(video({ title: ' ' }));
  const list = await invoke(['list', 'private', '--sort', 'views'], api);
  assert.equal(list.exitCode, 0);
  assert.equal(list.result.command, 'list');
  assert.equal(list.result.status, 'ok');
  assert.equal(list.result.items[0].id, ID);
  assert.equal(list.result.items[0].title, ' ');
  assert.equal(list.result.items[0].views, 12);
  assert.equal(list.result.items[0].likes, 3);
  assert.equal(list.result.filters.visibility, 'private');
  assert.equal(list.result.filters.sort, 'views');
  assert.equal(list.result.count, 1);
  const info = await invoke(['info', ID], api);
  assert.equal(info.exitCode, 0);
  assert.equal(info.result.command, 'info');
  assert.equal(info.result.video.id, ID);
  assert.equal(info.result.video.description, 'Original description');
  const analytics = await invoke(['analytics', ID, '--days', '90'], api);
  assert.equal(analytics.exitCode, 0);
  assert.equal(analytics.result.videoId, ID);
  assert.equal(analytics.result.days, 90);
  assert.deepEqual(analytics.result.analytics, { views: 22, points: [{ date: '2026-10-01', views: 2 }] });
  const accountAnalytics = await invoke(['analytics'], api);
  assert.equal(accountAnalytics.exitCode, 0);
  assert.equal(accountAnalytics.result.videoId, null);
  assert.equal(accountAnalytics.result.days, 28);
  assert.deepEqual(api.calls.filter(call => call[0] === 'analytics'), [['analytics', ID, 90], ['analytics', null, 28]]);
});

test('edit sends only explicit metadata and checks the persisted value after PATCH', async t => {
  await isolatedHome(t);
  await configCommand(['set', 'visibility', 'public']);
  await presetCommand(['add', 'share'], { visibility: 'public', rename: 'Preset title', description: 'Preset description' });
  await presetCommand(['use', 'share']);
  const api = mockApi();
  const edited = await invoke(['edit', ID, '-r', 'New title'], api);
  assert.equal(edited.exitCode, 0);
  assert.equal(edited.result.status, 'updated');
  assert.equal(edited.result.video.title, 'New title');
  assert.equal(edited.result.video.visibility, 'private');
  assert.equal(edited.result.video.description, 'Original description');
  assert.deepEqual(api.calls, [['auth'], ['patch', ID, { title: 'New title' }], ['get', ID]]);
  const explicitPreset = await invoke(['edit', ID, '--preset', 'share', '-r', 'CLI title'], api);
  assert.equal(explicitPreset.exitCode, 0);
  assert.equal(explicitPreset.result.video.visibility, 'public');
  assert.equal(explicitPreset.result.video.title, 'CLI title');
  assert.equal(explicitPreset.result.video.description, 'Preset description');
});

test('edit returns a failure when the server does not confirm the requested metadata', async t => {
  await isolatedHome(t);
  const api = mockApi();
  api.metadata = async (id, fields) => { api.calls.push(['patch', id, fields]); return video({ title: fields.title }); };
  const output = await invoke(['edit', ID, '--rename', 'Unconfirmed title'], api);
  assert.equal(output.exitCode, 1);
  assert.equal(output.result.status, 'failed');
  assert.match(output.result.error, /metadata was not confirmed/);
  assert.deepEqual(api.calls.map(call => call[0]), ['auth', 'patch', 'get']);
});

test('JSON argument failures are machine readable and do not authenticate or mutate', async t => {
  await isolatedHome(t);
  const api = mockApi();
  for (const args of [['list', '--unknown'], ['file.mp4', '--duration', '61'], ['edit', ID], ['setup']]) {
    const output = await invoke(args, api);
    assert.equal(output.exitCode, 1);
    assert.equal(output.result.status, 'failed');
    assert.equal(typeof output.result.error, 'string');
  }
  assert.deepEqual(api.calls, []);
});

test('config, presets, aliases and jobs work locally without authentication', async t => {
  const directory = await isolatedHome(t);
  const api = { async checkAuth() { throw new Error('Local commands must not authenticate'); } };
  let output = await invoke(['config', 'set', 'visibility', 'unlisted'], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.command, 'config');
  assert.equal(output.result.effective.visibility, 'unlisted');
  output = await invoke(['preset', 'add', 'sharing', '--visibility', 'public', '--rename', ' '], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.presets.sharing.rename, ' ');
  output = await invoke(['preset', 'use', 'sharing'], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.activePreset, 'sharing');
  output = await invoke(['config', 'show'], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.effective.visibility, 'public');
  const binDir = path.join(directory, 'commands');
  output = await invoke(['alias', 'add', 'smap', '--bin-dir', binDir], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.status, 'added');
  output = await invoke(['alias', 'list', '--bin-dir', binDir], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.aliases.find(item => item.name === 'smap').present, true);
  output = await invoke(['alias', 'remove', 'smap', '--bin-dir', binDir], api);
  assert.equal(output.exitCode, 0);
  output = await invoke(['jobs'], api);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(output.result.jobs, []);
});

test('resume keeps the saved metadata despite current defaults and an active preset', async t => {
  await isolatedHome(t);
  await configCommand(['set', 'visibility', 'public']);
  await configCommand(['set', 'rename', 'Current config title']);
  await presetCommand(['add', 'share'], { visibility: 'public', rename: 'Active preset title', description: 'New description' });
  await presetCommand(['use', 'share']);
  const metadata = { visibility: 'private', title: ' ', description: 'Saved job description' };
  const job = await readyJob(metadata);
  const api = mockApi();
  const output = await invoke(['resume', job.id], api);
  assert.equal(output.exitCode, 0);
  assert.equal(output.result.command, 'resume');
  assert.equal(output.result.status, 'uploaded');
  assert.equal(output.result.jobId, job.id);
  assert.equal(output.result.visibility, 'private');
  assert.equal(output.result.title, ' ');
  assert.deepEqual(api.calls.filter(call => call[0] === 'patch'), [['patch', ID, metadata]]);
  const saved = await loadJob(job.id);
  assert.equal(saved.stage, 'done');
  assert.deepEqual(saved.metadata, metadata);
  await assert.rejects(access(job.prepared), error => error.code === 'ENOENT');
});

test('resume overrides only explicitly requested fields and supports an explicitly selected preset', async t => {
  await isolatedHome(t);
  await configCommand(['set', 'visibility', 'public']);
  await presetCommand(['add', 'share'], { visibility: 'unlisted', description: 'Preset description' });
  const savedMetadata = { title: 'Saved title', visibility: 'private', description: 'Saved description' };
  const job = await readyJob(savedMetadata);
  const api = mockApi();
  let output = await invoke(['resume', job.id, '--rename', 'Explicit title'], api);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(api.calls.find(call => call[0] === 'patch')[2], { ...savedMetadata, title: 'Explicit title' });
  const other = await readyJob(savedMetadata);
  const otherApi = mockApi();
  output = await invoke(['resume', other.id, '--preset', 'share', '--visibility', 'public'], otherApi);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(otherApi.calls.find(call => call[0] === 'patch')[2], { title: 'Saved title', visibility: 'public', description: 'Preset description' });
});

test('legacy resume retains the originally requested Public metadata and completed jobs reject changes', async t => {
  await isolatedHome(t);
  const job = await readyJob();
  const api = mockApi();
  const completed = await invoke(['resume', job.id], api);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.result.visibility, 'public');
  assert.equal(completed.result.title, ' ');
  const patches = api.calls.filter(call => call[0] === 'patch').length;
  const changed = await invoke(['resume', job.id, '--visibility', 'private'], api);
  assert.equal(changed.exitCode, 1);
  assert.match(changed.result.error, /job is complete/);
  assert.equal(api.calls.filter(call => call[0] === 'patch').length, patches);
  const cached = await invoke(['resume', job.id], api);
  assert.equal(cached.exitCode, 0);
  assert.equal(cached.result.visibility, 'public');
});
