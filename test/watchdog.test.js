import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { closeWatchdogSession, createWatchdogSession, reserveGlobalUploads, scanWatchdogSession, watchdogCommand, watchdogPaths } from '../src/watchdog.js';

async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await realpath(await mkdtemp(path.join(temporaryRoot, 'smop-watchdog-')));
  assert.equal(path.dirname(directory), temporaryRoot);
  const folder = path.join(directory, 'videos');
  await mkdir(folder);
  const options = { configDir: path.join(directory, 'config'), stateDir: path.join(directory, 'state') };
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) await closeWatchdogSession(session);
    assert.equal(path.dirname(await realpath(directory)), temporaryRoot);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, folder, options, async session(target, extra) {
    const session = await createWatchdogSession(target, { ...options, ...extra });
    sessions.push(session); return session;
  } };
}

test('watchdogs persist resolved settings, snapshots and management without an account', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'old.mp4'), 'old video');
  const settings = { visibility: 'public', rename: '{folder} #{index} Part {part}', duration: 60, quality: '720p', start: 0, color: false, preset: 'shorts' };
  const added = await watchdogCommand(['add', 'clips', f.folder], { ...f.options, resolvedSettings: settings, recursive: true });
  assert.equal(added.status, 'added');
  assert.equal(added.ignoredFiles, 1);
  assert.equal(added.folder, f.folder);
  assert.deepEqual(added.settings, settings);
  const listed = await watchdogCommand(['list'], f.options);
  assert.equal(listed.watchdogs[0].running, false);
  assert.equal(listed.watchdogs[0].ignoredFiles, 1);
  assert.equal(listed.watchdogs[0].recursive, true);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).records.length, 0);
  await assert.rejects(watchdogCommand(['add', 'clips', f.folder], f.options), /already exists/);
  await assert.rejects(watchdogCommand(['add', '../escape', f.folder], f.options), /Watchdog names/);
  await watchdogCommand(['remove', 'clips'], f.options);
  assert.equal((await watchdogCommand(['list'], f.options)).watchdogs.length, 0);
  assert.equal(JSON.parse(await readFile(watchdogPaths(f.options).state, 'utf8')).watchdogs.clips.count, 0);
});

test('a changing video waits for stable bytes, skips the initial snapshot and deduplicates completed files on restart', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'old.mp4'), 'existing video');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, stable: 2 });
  const fresh = path.join(f.folder, 'fresh.mp4');
  await writeFile(fresh, 'first bytes');
  let now = 0;
  const calls = [];
  const uploadFile = async (file, context) => {
    calls.push({ file, context, bytes: await readFile(file, 'utf8') });
    assert.deepEqual(await context.reserveParts(3), { global: 1, index: 1, parts: 3 });
    assert.deepEqual(await context.reserveParts(3), { global: 1, index: 1, parts: 3 });
    await context.recordCheckpoint({ jobIds: ['job-one'] });
    return { status: 'uploaded', videoIds: ['video-one', 'video-two', 'video-three'] };
  };
  const session = await f.session('clips', { now: () => now, uploadFile });
  assert.equal((await scanWatchdogSession(session)).attempted, 0);
  now = 1000;
  await scanWatchdogSession(session);
  assert.equal(calls.length, 0);
  await writeFile(fresh, 'finished video bytes');
  now = 3000;
  await scanWatchdogSession(session);
  assert.equal(calls.length, 0);
  now = 5000;
  assert.equal((await scanWatchdogSession(session)).attempted, 1);
  assert.equal(calls[0].bytes, 'finished video bytes');
  assert.equal(calls[0].context.filename, 'fresh');
  await scanWatchdogSession(session);
  assert.equal(calls.length, 1);
  const status = await watchdogCommand(['show', 'clips'], f.options);
  assert.equal(status.uploadedClips, 3);
  assert.equal(status.reservedClips, 3);
  assert.deepEqual(status.records[0].jobIds, ['job-one']);
  assert.deepEqual(status.records[0].videoIds, ['video-one', 'video-two', 'video-three']);
  await closeWatchdogSession(session);
  const restarted = await f.session('clips', { now: () => now, uploadFile: async () => { throw new Error('Duplicate upload'); } });
  assert.equal((await scanWatchdogSession(restarted)).attempted, 0);
});

test('completed source files remain deduplicated after removing and adding the same watchdog', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  let calls = 0;
  const uploadFile = async () => { calls++; return { status: 'uploaded', jobId: 'job-one', videoId: 'video-one' }; };
  const session = await f.session('clips', { uploadFile });
  await scanWatchdogSession(session);
  assert.equal(calls, 1);
  await closeWatchdogSession(session);
  await watchdogCommand(['remove', 'clips'], f.options);
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  const restarted = await f.session('clips', { uploadFile });
  await scanWatchdogSession(restarted);
  assert.equal(calls, 1);
});

test('a video changed after the initial skipped snapshot becomes a new stable arrival', async t => {
  const f = await fixture(t);
  const file = path.join(f.folder, 'clip.mp4');
  await writeFile(file, 'old video');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, stable: 0 });
  let calls = 0;
  const session = await f.session('clips', { uploadFile: async () => { calls++; return { status: 'uploaded' }; } });
  await scanWatchdogSession(session);
  assert.equal(calls, 0);
  await writeFile(file, 'replacement video with different bytes');
  await scanWatchdogSession(session);
  assert.equal(calls, 1);
});

test('uncertain uploads are blocked without repeating and an explicit retry resumes saved jobs', async t => {
  const f = await fixture(t);
  const file = path.join(f.folder, 'clip.mp4');
  await writeFile(file, 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  let calls = 0;
  const events = [];
  const session = await f.session('clips', { emit: event => events.push(event), uploadFile: async (source, context) => {
    calls++;
    if (calls === 1) { await context.recordCheckpoint({ jobIds: ['saved-parent'] }); throw new Error('Response lost'); }
    assert.deepEqual(context.existingJobIds, ['saved-parent']);
    assert.equal(context.uncertain, true);
    assert.equal(context.global, 1);
    return { status: 'uploaded', jobIds: ['saved-parent'], videoIds: ['existing-draft'] };
  } });
  await scanWatchdogSession(session);
  await scanWatchdogSession(session);
  assert.equal(calls, 1);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).blockedFiles, 1);
  const retried = await watchdogCommand(['retry', 'clips', file], f.options);
  assert.equal(retried.status, 'retry-requested');
  assert.deepEqual(retried.records[0].jobIds, ['saved-parent']);
  await scanWatchdogSession(session);
  assert.equal(calls, 2);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).uploadedClips, 1);
  assert.ok(events.some(event => event.type === 'upload_blocked' && event.uncertain));
});

test('retry canonicalizes folder aliases for existing and removed sources without following outside links', async t => {
  const f = await fixture(t);
  const nested = path.join(f.folder, 'nested');
  const file = path.join(nested, 'clip.mp4');
  await mkdir(nested);
  await writeFile(file, 'clip');
  const alias = path.join(f.directory, 'folder-alias');
  await symlink(f.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'foreign.mp4'), 'outside video');
  await symlink(outside, path.join(f.folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, recursive: true, stable: 0 });
  let calls = 0;
  const session = await f.session('clips', { uploadFile: async (source, context) => {
    calls++;
    assert.equal(source, file);
    if (calls === 1) await context.recordCheckpoint({ jobIds: ['saved-parent'] });
    else assert.deepEqual(context.existingJobIds, ['saved-parent']);
    if (calls < 3) throw new Error('Upload interrupted');
    return { status: 'uploaded', videoIds: ['resumed-video'] };
  } });
  await scanWatchdogSession(session);
  for (const unsafe of ['foreign.mp4', 'not-created.mp4']) {
    await assert.rejects(watchdogCommand(['retry', 'clips', path.join(alias, 'escape', unsafe)], f.options), /inside the watchdog folder/);
  }
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).records[0].status, 'blocked');
  const retryFile = path.join(alias, 'nested', 'clip.mp4');
  const requested = await watchdogCommand(['retry', 'clips', retryFile], f.options);
  assert.equal(requested.records[0].file, file);
  assert.deepEqual(requested.records[0].jobIds, ['saved-parent']);
  await scanWatchdogSession(session);
  assert.equal(calls, 2);
  assert.equal(path.dirname(await realpath(nested)), f.folder);
  await rm(nested, { recursive: true });
  await watchdogCommand(['retry', 'clips', retryFile], f.options);
  await scanWatchdogSession(session);
  assert.equal(calls, 3);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).uploadedClips, 1);
});

test('an interrupted in-flight journal is never automatically recreated on restart', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  const session = await f.session('clips', { uploadFile: async (file, context) => {
    await context.recordCheckpoint({ jobIds: ['parent-before-crash'] });
    throw new Error('Stopped');
  } });
  await scanWatchdogSession(session);
  await closeWatchdogSession(session);
  const stateFile = watchdogPaths(f.options).state;
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  Object.values(state.watchdogs.clips.records)[0].status = 'uploading';
  await writeFile(stateFile, JSON.stringify(state));
  let calls = 0;
  const restarted = await f.session('clips', { uploadFile: async () => { calls++; } });
  await scanWatchdogSession(restarted);
  assert.equal(calls, 0);
  const record = (await watchdogCommand(['show', 'clips'], f.options)).records[0];
  assert.equal(record.status, 'blocked');
  assert.equal(record.uncertain, true);
  assert.deepEqual(record.jobIds, ['parent-before-crash']);
});

test('an explicit retry resumes saved jobs after the source video has been removed', async t => {
  const f = await fixture(t);
  const file = path.join(f.folder, 'clip.mp4');
  await writeFile(file, 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  let calls = 0;
  const session = await f.session('clips', { uploadFile: async (source, context) => {
    calls++;
    if (calls === 1) {
      await context.recordCheckpoint({ jobIds: ['prepared-parent'] });
      throw new Error('Upload interrupted');
    }
    assert.deepEqual(context.existingJobIds, ['prepared-parent']);
    return { status: 'uploaded', videoIds: ['resumed-video'] };
  } });
  await scanWatchdogSession(session);
  await rm(file);
  await watchdogCommand(['retry', 'clips'], f.options);
  await scanWatchdogSession(session);
  assert.equal(calls, 2);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).uploadedClips, 1);
});

test('global clip ordinals advance across folders and explicit retries can reserve a new contiguous range', async t => {
  const f = await fixture(t);
  const secondFolder = path.join(f.directory, 'other');
  await mkdir(secondFolder);
  await writeFile(path.join(f.folder, 'one.mp4'), 'one');
  await writeFile(path.join(secondFolder, 'two.mp4'), 'two');
  await watchdogCommand(['add', 'first', f.folder], { ...f.options, existing: true, stable: 0 });
  await watchdogCommand(['add', 'second', secondFolder], { ...f.options, existing: true, stable: 0 });
  const seen = [];
  let firstCalls = 0;
  const session = await f.session('all', { uploadFile: async (file, context) => {
    if (context.watchdog === 'first' && firstCalls++ === 0) throw new Error('Pre-probe failure');
    const count = context.watchdog === 'first' ? 3 : 2;
    const reservation = await context.reserveParts(count);
    seen.push({ watchdog: context.watchdog, ...reservation, contextGlobal: context.global, contextIndex: context.index });
    return { status: 'uploaded' };
  } });
  await scanWatchdogSession(session);
  assert.deepEqual(seen, [{ watchdog: 'second', global: 2, index: 1, parts: 2, contextGlobal: 2, contextIndex: 1 }]);
  await watchdogCommand(['retry', 'first'], f.options);
  await scanWatchdogSession(session);
  assert.deepEqual(seen[1], { watchdog: 'first', global: 4, index: 2, parts: 3, contextGlobal: 4, contextIndex: 2 });
  assert.equal((await watchdogCommand(['status'], f.options)).globalReservedClips, 6);
});

test('manual uploads reserve the same monotonic global counter used by watchdogs', async t => {
  const f = await fixture(t);
  assert.deepEqual(await reserveGlobalUploads(3, f.options), { global: 1, index: 1, parts: 3 });
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  const session = await f.session('clips', { uploadFile: async (file, context) => {
    assert.deepEqual(await context.reserveParts(2), { global: 4, index: 1, parts: 2 });
    return { status: 'uploaded' };
  } });
  await scanWatchdogSession(session);
  assert.deepEqual(await reserveGlobalUploads(1, f.options), { global: 6, index: 6, parts: 1 });
  assert.equal((await watchdogCommand(['status'], f.options)).globalReservedClips, 6);
  await assert.rejects(reserveGlobalUploads(0, f.options), /positive integer/);
});

test('only one runner starts and stop signals the owned token without killing a process', async t => {
  const f = await fixture(t);
  await watchdogCommand(['add', 'clips', f.folder], f.options);
  const events = [];
  const session = await f.session('clips', { emit: event => events.push(event), uploadFile: async () => ({ status: 'uploaded' }) });
  await assert.rejects(createWatchdogSession('clips', { ...f.options, uploadFile: async () => {} }), /already active/);
  const status = await watchdogCommand(['status', 'clips'], f.options);
  assert.equal(status.watchdogs[0].running, true);
  assert.equal(status.watchdogs[0].pid, process.pid);
  await assert.rejects(watchdogCommand(['remove', 'clips'], f.options), /Stop this watchdog/);
  const stopped = await watchdogCommand(['stop', 'clips'], f.options);
  assert.equal(stopped.status, 'stop-requested');
  assert.equal((await scanWatchdogSession(session)).active, 0);
  assert.ok(events.some(event => event.type === 'watchdog_stopped'));
  await closeWatchdogSession(session);
  assert.equal((await watchdogCommand(['status', 'clips'], f.options)).watchdogs[0].running, false);
  assert.equal((await watchdogCommand(['stop', 'clips'], f.options)).status, 'not-running');
});

test('recursive scans skip symlinks and unsupported files and reject overlapping folders or self-export loops', async t => {
  const f = await fixture(t);
  const nested = path.join(f.folder, 'nested');
  await mkdir(nested);
  await writeFile(path.join(nested, 'inside.MP4'), 'video');
  await writeFile(path.join(f.folder, 'ignore.txt'), 'text');
  await writeFile(path.join(f.folder, 'empty.mp4'), '');
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.mp4'), 'outside video');
  await symlink(outside, path.join(f.folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, recursive: true, stable: 0 });
  await assert.rejects(watchdogCommand(['add', 'nested', nested], f.options), /must not overlap/);
  const uploaded = [];
  const session = await f.session('clips', { uploadFile: async file => { uploaded.push(file); return { status: 'uploaded' }; } });
  await scanWatchdogSession(session);
  assert.deepEqual(uploaded, [path.join(nested, 'inside.MP4')]);
  await closeWatchdogSession(session);
  await watchdogCommand(['remove', 'clips'], f.options);
  await assert.rejects(watchdogCommand(['add', 'loop', f.folder], { ...f.options, recursive: true,
    settings: { ...DEFAULT_TEST_SETTINGS, output: nested } }), /outside the watched folder/);
  await assert.rejects(watchdogCommand(['add', 'linked', path.join(f.folder, 'linked')], f.options), /without a symbolic link/);
});

test('export symlinks and their uncreated descendants are resolved before rejecting self-upload loops', async t => {
  const f = await fixture(t);
  const alias = path.join(f.directory, 'export-alias');
  await symlink(f.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const output of [alias, path.join(alias, 'not-created', 'exports')]) {
    await assert.rejects(watchdogCommand(['add', 'loop', f.folder], { ...f.options, recursive: true,
      settings: { ...DEFAULT_TEST_SETTINGS, output } }), /outside the watched folder/);
  }
  assert.equal((await watchdogCommand(['list'], f.options)).watchdogs.length, 0);
});

test('the saved export destination is absolute and a later symlink change is blocked before the upload callback', async t => {
  const f = await fixture(t);
  const output = path.join(f.directory, 'exports');
  const relative = path.relative(process.cwd(), output);
  const added = await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, recursive: true, stable: 0,
    settings: { ...DEFAULT_TEST_SETTINGS, output: relative } });
  assert.equal(added.settings.output, output);
  await symlink(f.folder, output, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  let calls = 0;
  const session = await f.session('clips', { uploadFile: async () => { calls++; return { status: 'uploaded' }; } });
  await scanWatchdogSession(session);
  assert.equal(calls, 0);
  const record = (await watchdogCommand(['show', 'clips'], f.options)).records[0];
  assert.equal(record.status, 'blocked');
  assert.match(record.error, /outside the watched folder/);
});

test('blocked quota records and events retain safe structured limits without unrelated fields', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  const events = [];
  const quota = { allowed: false, proposedBytes: 123, reasons: ['Daily upload limit exceeded'], unavailable: false,
    storage: { tier: 'new', label: 'New account', quotaBytes: 1000, usedBytes: 999, remainingBytes: 1,
      dailyVideoLimit: 100, dailyVideoBytes: 100, dailyRemainingBytes: 0, overQuota: false,
      source: 'https://smolish.com/storage/apply', fetchedAt: '2026-10-01T00:00:00.000Z', cookie: 'must-not-survive' },
    cookie: 'must-not-survive' };
  const session = await f.session('clips', { emit: event => events.push(event), uploadFile: async () => {
    const error = new Error('Upload stopped by the storage check.'); error.quota = quota; throw error;
  } });
  await scanWatchdogSession(session);
  const blocked = (await watchdogCommand(['show', 'clips'], f.options)).records[0];
  assert.equal(blocked.quota.proposedBytes, 123);
  assert.deepEqual(blocked.quota.reasons, ['Daily upload limit exceeded']);
  assert.equal(blocked.quota.storage.dailyRemainingBytes, 0);
  assert.equal(blocked.quota.storage.source, 'https://smolish.com/storage/apply');
  assert.deepEqual(events.find(event => event.type === 'upload_blocked').quota, blocked.quota);
  assert.doesNotMatch(JSON.stringify(blocked), /cookie|must-not-survive/);
  assert.doesNotMatch(await readFile(watchdogPaths(f.options).state, 'utf8'), /must-not-survive/);
});

test('stopping one folder updates runner status and allows removing it while another remains active', async t => {
  const f = await fixture(t);
  const second = path.join(f.directory, 'other');
  await mkdir(second);
  await watchdogCommand(['add', 'first', f.folder], f.options);
  await watchdogCommand(['add', 'second', second], f.options);
  const session = await f.session('all', { uploadFile: async () => ({ status: 'uploaded' }) });
  await watchdogCommand(['stop', 'first'], f.options);
  assert.equal((await scanWatchdogSession(session)).active, 1);
  const status = await watchdogCommand(['status'], f.options);
  assert.equal(status.watchdogs.find(record => record.name === 'first').running, false);
  assert.equal(status.watchdogs.find(record => record.name === 'second').running, true);
  assert.equal((await watchdogCommand(['remove', 'first'], f.options)).status, 'removed');
  assert.equal((await scanWatchdogSession(session)).active, 1);
});

test('a long scan interval still acknowledges a stop promptly without scanning new files during the wait', async t => {
  const f = await fixture(t);
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, interval: 300, stable: 0 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let uploads = 0;
  const running = watchdogCommand(['start', 'clips'], { ...f.options, signal: controller.signal,
    emit: event => { if (event.type === 'watchdog_started') started(); },
    uploadFile: async () => { uploads++; return { status: 'uploaded' }; } });
  await ready;
  await delay(150);
  await writeFile(path.join(f.folder, 'new.mp4'), 'new video');
  const requestedAt = Date.now();
  await watchdogCommand(['stop', 'clips'], f.options);
  const result = await Promise.race([running, delay(2500).then(() => { controller.abort(); throw new Error('Stop was not acknowledged promptly'); })]);
  assert.equal(result.status, 'stopped');
  assert.ok(Date.now() - requestedAt < 2500);
  assert.equal(uploads, 0);
});

test('a stop before creating any job defers the file safely and reuses its counter on the next start', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.folder, 'clip.mp4'), 'clip');
  await watchdogCommand(['add', 'clips', f.folder], { ...f.options, existing: true, stable: 0 });
  const events = [];
  const session = await f.session('clips', { emit: event => events.push(event), uploadFile: async (file, context) => {
    assert.equal(await context.shouldStop(), false);
    await watchdogCommand(['stop', 'clips'], f.options);
    assert.equal(await context.shouldStop(), true);
    const error = new Error('Stopped before an upload job was created.'); error.code = 'WATCHDOG_STOP_REQUESTED'; throw error;
  } });
  assert.equal((await scanWatchdogSession(session)).active, 0);
  assert.equal(events.find(event => event.type === 'upload_deferred').uncertain, false);
  assert.equal((await watchdogCommand(['show', 'clips'], f.options)).records[0].status, 'retry');
  await closeWatchdogSession(session);
  const restarted = await f.session('clips', { uploadFile: async (file, context) => {
    assert.equal(context.global, 1); assert.equal(context.index, 1);
    return { status: 'uploaded' };
  } });
  await scanWatchdogSession(restarted);
  assert.equal((await watchdogCommand(['status'], f.options)).globalReservedClips, 1);
});

const DEFAULT_TEST_SETTINGS = { visibility: 'private', rename: ' ', start: 0, duration: 60, quality: 'best', color: true };
