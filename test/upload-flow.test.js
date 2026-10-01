import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createJob, saveJob, loadJob, acquireLock } from '../src/jobs.js';
import { fingerprint } from '../src/uploader.js';
import { publishUploadJobs, overrideJobMetadata } from '../src/upload-flow.js';
import { main } from '../src/cli.js';
import { watchdogCommand } from '../src/watchdog.js';
import { parseArgs } from '../src/arguments.js';

async function home(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smup-flow-test-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  const names = ['SMUP_HOME', 'SMUP_CONFIG'];
  const before = names.map(name => process.env[name]);
  process.env.SMUP_HOME = root; delete process.env.SMUP_CONFIG;
  t.after(async () => {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function prepared(source = 'video.mp4', part = 1, parts = 1) {
  const job = await createJob(source, (part - 1) * 60);
  job.prepared = path.join(job.directory, 'prepared.mp4');
  await writeFile(job.prepared, Buffer.alloc(40));
  Object.assign(job, { filename: 'video.mp4', stage: 'prepared', sizeBytes: 40, durationSeconds: 30,
    metadata: { title: parts > 1 ? `Part ${part}` : ' ', visibility: 'private' }, part, parts, sha256: await fingerprint(job.prepared) });
  await saveJob(job); return job;
}
async function batch() {
  const parent = await createJob('source.mp4', 0);
  const jobs = [await prepared('source.mp4', 1, 2), await prepared('source.mp4', 2, 2)];
  for (const job of jobs) { job.parentId = parent.id; await saveJob(job); }
  Object.assign(parent, { kind: 'batch', children: jobs.map(j => j.id), stage: 'prepared', partCount: 2,
    sizeBytes: 80, durationSeconds: 60, metadata: { title: 'Part 1', visibility: 'private' } });
  await saveJob(parent); return { parent, jobs };
}
function apiFixture({ limit = 100, changeAfterFirst = false } = {}) {
  const videos = new Map(), calls = [];
  let used = 0, daily = 0, creates = 0, reads = 0;
  const api = {
    calls, videos,
    async checkAuth() { calls.push(['auth']); return { id: '1', name: 'Fixture' }; },
    async storagePage() {
      reads++; if (changeAfterFirst && reads === 2) used = 95;
      const data = { tier: 'new', quotaBytes: limit, usedBytes: used, dailyVideoLimit: limit, dailyVideoBytes: daily };
      return `<script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ initial: data })])})</script>`;
    },
    async createDraft({ sizeBytes }) {
      calls.push(['create']); creates++; used += sizeBytes; daily += sizeBytes;
      const video = { id: String(creates), title: 'original', description: 'Preserved', visibility: 'private', status: 'uploading' };
      videos.set(video.id, video); return { video };
    },
    async getVideo(id) { return { ...videos.get(id) }; },
    async metadata(id, fields) { calls.push(['metadata', id, fields]); Object.assign(videos.get(id), fields); return { ...videos.get(id) }; },
    async parts() { return { partSize: 40, partCount: 1, missing: [1], uploaded: [], urls: { 1: 'https://storage.example/part' } }; },
    async putPart() { calls.push(['put']); },
    async complete(id) { videos.get(id).status = 'ready'; return { ...videos.get(id) }; },
    set usage(value) { used = value; daily = value; },
    get creates() { return creates; },
  };
  return api;
}
function streams(onLine) {
  const stdout = { isTTY: false, text: '', write(value) { this.text += value; onLine?.(String(value)); } };
  const stderr = { isTTY: false, text: '', write(value) { this.text += value; } };
  return { stdout, stderr };
}

test('aggregate storage blocks the complete batch before any draft and explicit attempts use the same API', async t => {
  await home(t);
  const { parent, jobs } = await batch();
  const api = apiFixture({ limit: 60 });
  await assert.rejects(publishUploadJobs(api, parent, jobs), error => error.quota.proposedBytes === 80);
  assert.equal(api.creates, 0);
  assert.equal(parent.stage, 'prepared');
  const result = await publishUploadJobs(api, parent, jobs, { tryAnyway: true });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.items.length, 2);
  assert.equal(api.creates, 2);
});
test('a changed quota stops later clips and resuming preserves completed uploads and metadata', async t => {
  await home(t);
  const { parent, jobs } = await batch();
  const api = apiFixture({ changeAfterFirst: true });
  await assert.rejects(publishUploadJobs(api, parent, jobs), error => Boolean(error.quota));
  assert.equal(api.creates, 1);
  assert.equal(jobs[0].stage, 'done');
  assert.equal(jobs[1].stage, 'prepared');
  await overrideJobMetadata(parent, jobs, { title: 'Revised Part 2', visibility: 'public' });
  assert.equal(jobs[0].metadata.title, 'Part 1');
  api.usage = 40;
  const result = await publishUploadJobs(api, parent, jobs);
  assert.equal(api.creates, 2);
  assert.equal(result.items[0].title, 'Part 1');
  assert.equal(result.items[1].title, 'Revised Part 2');
  assert.equal((await loadJob(parent.id)).stage, 'done');
});
test('a damaged later prepared clip stops a batch before its first remote draft', async t => {
  await home(t);
  const { parent, jobs } = await batch();
  await writeFile(jobs[1].prepared, Buffer.alloc(40, 1));
  const api = apiFixture();
  await assert.rejects(publishUploadJobs(api, parent, jobs), /prepared clip has changed/);
  assert.equal(api.creates, 0);
});
test('new parser settings and local watchdog registration preserve resolved split options', async t => {
  const root = await home(t);
  const folder = path.join(root, 'Inbox'); await mkdir(folder);
  const parsed = parseArgs(['watchdog', 'add', folder, '--name', 'clips', '--split', '--part-label', 'suffix', '-r', '{filename} {global}', '--existing']);
  assert.deepEqual(parsed.args, ['add', 'clips', folder]);
  assert.equal(parsed.overrides.split, true);
  assert.equal(parsed.overrides.partLabel, 'suffix');
  assert.throws(() => parseArgs(['video.mp4', '--split', '--no-split']), /either/);
  assert.throws(() => parseArgs(['watchdog', 'start', 'clips', '--visibility', 'public']), /only accepted/);
  const io = streams();
  const code = await main(['watchdog', 'add', folder, '--name', 'clips', '--split', '--json'], io);
  assert.equal(code, 0, io.stderr.text);
  const output = JSON.parse(io.stdout.text);
  assert.equal(output.settings.split, true);
  assert.equal(output.settings.visibility, 'private');
});
test('CLI storage proposals use live counters and report a machine readable quota stop with saved jobs', async t => {
  await home(t);
  const api = apiFixture({ limit: 30 });
  let io = streams();
  assert.equal(await main(['storage', '--bytes', '40', '--json'], { ...io, api }), 1);
  assert.equal(JSON.parse(io.stdout.text).status, 'attention');
  const job = await prepared();
  io = streams();
  const code = await main(['resume', job.id, '--json'], { ...io, api });
  assert.equal(code, 1);
  const output = JSON.parse(io.stdout.text);
  assert.equal(output.status, 'failed');
  assert.equal(output.jobId, job.id);
  assert.equal(output.quota.proposedBytes, 40);
  assert.equal(api.creates, 0);
});
test('foreground watchdog CLI emits NDJSON, prepares and uploads once, and stops cooperatively', async t => {
  const root = await home(t);
  const folder = path.join(root, 'Inbox'); await mkdir(folder);
  await writeFile(path.join(folder, 'arrival.mp4'), 'stable source');
  await watchdogCommand(['add', 'clips', folder], { existing: true, stable: 0, interval: 0.1,
    settings: { visibility: 'private', rename: '{filename} {global}', start: 0, duration: 60, quality: 'best', split: false, splitThreshold: 90, partLabel: 'prefix', color: false } });
  const api = apiFixture();
  let stop;
  const io = streams(line => {
    const event = JSON.parse(line);
    if (event.type === 'upload_completed' || event.type === 'upload_blocked') stop = watchdogCommand(['stop', 'clips']);
  });
  const emergency = setTimeout(() => { stop = watchdogCommand(['stop', 'clips']); }, 5000);
  try {
    const code = await main(['watchdog', 'start', 'clips', '--json'], { ...io, api,
      prepareUploadJobs: async (file, settings, hooks) => {
        const job = await prepared(file); await hooks.onJobCreated(job); await hooks.onPlan(1);
        job.metadata.title = `arrival ${hooks.context.global}`; await saveJob(job);
        return { job, jobs: [job], batch: false };
      } });
    await stop;
    assert.equal(code, 0, io.stderr.text);
    assert.equal(api.creates, 1, io.stdout.text);
    const events = io.stdout.text.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.type === 'upload_completed'));
    assert.equal(events.at(-1).status, 'stopped');
    assert.doesNotMatch(io.stdout.text + io.stderr.text, /\x1b/);
  } finally { clearTimeout(emergency); }
});
test('a watchdog waiting for a manual upload can stop and requeue without a permanent block', async t => {
  const root = await home(t);
  const folder = path.join(root, 'Inbox'); await mkdir(folder);
  await writeFile(path.join(folder, 'arrival.mp4'), 'stable source');
  await watchdogCommand(['add', 'clips', folder], { existing: true, stable: 0, interval: 0.1 });
  const release = await acquireLock();
  const api = apiFixture();
  let stopping;
  const io = streams(line => {
    if (JSON.parse(line).type === 'upload_started') stopping = watchdogCommand(['stop', 'clips']);
  });
  try {
    assert.equal(await main(['watchdog', 'start', 'clips', '--json'], { ...io, api }), 0);
    await stopping;
    assert.equal(api.creates, 0);
    const record = (await watchdogCommand(['show', 'clips'])).records[0];
    assert.equal(record.status, 'retry');
    assert.equal(record.uncertain, false);
    assert.ok(io.stdout.text.includes('upload_deferred'));
  } finally { await release(); }
});
