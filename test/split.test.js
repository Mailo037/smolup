import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { planClips, renderTitle, prepareUploadJobs, loadUploadJobs } from '../src/split.js';

const settings = { start: 0, duration: 60, quality: 'best', visibility: 'private', rename: ' ',
  split: true, splitThreshold: 90, partLabel: 'prefix' };

async function fixture(t, { duration = 95, failPart = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smolup-split-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'sample.mp4');
  await writeFile(source, 'original source');
  const stored = new Map(), saves = [], preparations = [], downloads = [], events = [];
  const dependencies = {
    createJob: async (source, start) => {
      const id = randomUUID();
      const jobDirectory = path.join(directory, 'jobs', id);
      await mkdir(jobDirectory, { recursive: true });
      const job = { id, directory: jobDirectory, source, start, stage: 'preparing', createdAt: new Date().toISOString() };
      stored.set(id, structuredClone(job)); events.push('created'); return job;
    },
    saveJob: async job => { const copy = structuredClone(job); saves.push(copy); stored.set(job.id, copy); },
    mediaTools: async () => ({}),
    probe: async () => ({ duration }),
    downloadVideo: async (url, output, options) => {
      downloads.push({ url, options });
      const file = path.join(output, 'downloaded.mp4');
      await writeFile(file, 'downloaded source'); return file;
    },
    prepareVideo: async (input, output, options) => {
      const part = preparations.length + 1;
      preparations.push({ input, output, options });
      if (part === failPart) throw new Error('Simulated preparation failure.');
      const bytes = `${options.start}:${options.duration}`;
      await writeFile(output, bytes);
      return { duration: options.duration, sizeBytes: Buffer.byteLength(bytes) };
    },
  };
  return { directory, source, stored, saves, preparations, downloads, events, dependencies };
}

test('splitting keeps consecutive 60-second boundaries and the last remainder', () => {
  assert.deepEqual(planClips(155, settings), [
    { part: 1, parts: 3, start: 0, duration: 60 },
    { part: 2, parts: 3, start: 60, duration: 60 },
    { part: 3, parts: 3, start: 120, duration: 35 },
  ]);
  assert.deepEqual(planClips(155, { ...settings, start: 5, duration: 30 }),
    Array.from({ length: 5 }, (_, i) => ({ part: i + 1, parts: 5, start: 5 + i * 30, duration: 30 })));
  assert.equal(planClips(89.99, settings).length, 1);
  assert.equal(planClips(90, settings).length, 2);
  assert.equal(planClips(180, settings).length, 3);
  assert.equal(planClips(180, { ...settings, split: false }).length, 1);
  assert.equal(planClips(120, { ...settings, start: 35 }).length, 1);
  assert.throws(() => planClips(60, { start: 60 }), /beyond the end/);
  assert.throws(() => planClips(95, { split: true, splitThreshold: 50 }), /at least 60/);
});

test('title templates, automatic part labels and counters compose without duplicate labels', () => {
  assert.equal(renderTitle(' ', { part: 1, parts: 3 }), 'Part 1');
  assert.equal(renderTitle('My clip', { part: 2, parts: 3, partLabel: 'suffix' }), 'My clip Part 2');
  assert.equal(renderTitle(' ', { part: 2, parts: 3, partLabel: 'none' }), ' ');
  assert.equal(renderTitle(' ', { part: 1, parts: 1 }), ' ');
  assert.equal(renderTitle('{folder} {filename} #{global}/{index} Part {part}/{parts}',
    { filename: 'clip', folder: 'incoming', global: 11, index: 4, part: 2, parts: 3 }), 'incoming clip #11/4 Part 2/3');
  assert.equal(renderTitle('{parts} clips', { part: 2, parts: 3 }), 'Part 2 3 clips');
  assert.throws(() => renderTitle('{unknown}'), /Unknown title variable/);
  assert.throws(() => renderTitle('{filename}', { filename: 'x'.repeat(101) }), /100 characters/);
  assert.throws(() => renderTitle('test', { global: Number.MAX_SAFE_INTEGER + 1 }), /safe integers/);
});

test('every batch clip is prepared before the manifest can be resumed, and sources stay unchanged', async t => {
  const f = await fixture(t, { duration: 155 });
  const output = path.join(f.directory, 'export');
  const result = await prepareUploadJobs(f.source, { ...settings, rename: '{filename} #{global}-{index}', output }, {
    dependencies: f.dependencies, context: { global: 8, index: 3 },
    onJobCreated: job => { assert.equal(job.stage, 'preparing'); assert.equal(job.settings, undefined); f.events.push('checkpoint'); },
    onPlan: count => { assert.equal(count, 3); assert.equal(f.preparations.length, 0); f.events.push('plan'); },
  });
  assert.deepEqual(f.events.slice(0, 3), ['created', 'checkpoint', 'plan']);
  assert.equal(result.batch, true);
  assert.equal(result.job.kind, 'batch');
  assert.equal(result.job.stage, 'prepared');
  assert.equal(result.job.partCount, 3);
  assert.equal(result.job.durationSeconds, 155);
  assert.equal(result.job.sizeBytes, result.jobs.reduce((total, job) => total + job.sizeBytes, 0));
  assert.deepEqual(result.jobs.map(job => job.metadata.title), ['Part 1 sample #8-3', 'Part 2 sample #9-4', 'Part 3 sample #10-5']);
  assert.ok(result.jobs.every(job => job.stage === 'prepared' && job.parentId === result.job.id && /^[a-f0-9]{64}$/.test(job.sha256)));
  assert.ok(f.saves.filter(job => job.id === result.job.id).slice(0, -1).every(job => job.stage === 'preparing'));
  assert.deepEqual(f.preparations.map(call => [call.options.start, call.options.duration]), [[0, 60], [60, 60], [120, 35]]);
  assert.equal(await readFile(f.source, 'utf8'), 'original source');
  for (const child of result.jobs) assert.equal(await readFile(child.output, 'utf8'), await readFile(child.prepared, 'utf8'));
  assert.deepEqual((await loadUploadJobs(result.job, { load: async id => f.stored.get(id) })).map(job => job.id), result.job.children);
});

test('failed preparation leaves the parent incomplete so a partly cut source cannot upload', async t => {
  const f = await fixture(t, { duration: 155, failPart: 2 });
  let parent;
  await assert.rejects(prepareUploadJobs(f.source, settings, { dependencies: f.dependencies,
    onJobCreated: job => { parent = job; } }), /Simulated preparation failure/);
  assert.equal(f.stored.get(parent.id).stage, 'preparing');
  assert.equal(parent.children.length, 2);
  await assert.rejects(loadUploadJobs(parent, { load: async id => f.stored.get(id) }), /Batch preparation was incomplete/);
  assert.equal(await readFile(f.source, 'utf8'), 'original source');
});

test('full URL download preserves later clips and applies the source offset locally', async t => {
  const f = await fixture(t, { duration: 155 });
  const result = await prepareUploadJobs('https://example.com/video', { ...settings, start: 5 }, {
    dependencies: f.dependencies, context: { folder: 'incoming' },
  });
  assert.equal(f.downloads[0].options.duration, null);
  assert.equal(f.downloads[0].options.start, 5);
  assert.deepEqual(f.preparations.map(call => [call.options.start, call.options.duration]), [[5, 60], [65, 60], [125, 30]]);
  assert.equal(result.jobs[2].metadata.title, 'Part 3');
  await assert.rejects(stat(path.join(result.job.directory, 'download')), error => error.code === 'ENOENT');
});

test('short and unsplit uploads keep one job, one blank title and the existing URL section behavior', async t => {
  const f = await fixture(t, { duration: 20 });
  const result = await prepareUploadJobs('https://example.com/video', { ...settings, split: false, start: 5, duration: 20 }, { dependencies: f.dependencies });
  assert.equal(result.batch, false);
  assert.equal(result.job, result.jobs[0]);
  assert.equal(result.job.metadata.title, ' ');
  assert.equal(result.job.metadata.visibility, 'private');
  assert.equal(f.downloads[0].options.duration, 20);
  assert.equal(f.downloads[0].options.start, 5);
  assert.equal(f.preparations[0].options.start, 0);
  assert.deepEqual(await loadUploadJobs(result.job), [result.job]);
});

test('resume validates child ownership and ordinal ordering while retaining completed clips', async t => {
  const f = await fixture(t);
  const result = await prepareUploadJobs(f.source, settings, { dependencies: f.dependencies });
  const first = f.stored.get(result.jobs[0].id);
  first.stage = 'done'; first.videoId = '123'; first.result = { status: 'uploaded', videoId: '123' };
  assert.equal((await loadUploadJobs(result.job, { load: async id => f.stored.get(id) }))[0].videoId, '123');
  const second = f.stored.get(result.jobs[1].id);
  second.parentId = randomUUID();
  await assert.rejects(loadUploadJobs(result.job, { load: async id => f.stored.get(id) }), /damaged clip/);
  await assert.rejects(loadUploadJobs({ ...result.job, children: [first.id, first.id] }), /Batch preparation was incomplete/);
});

test('watchdog counters reserved by onPlan are read before rendering titles', async t => {
  const f = await fixture(t);
  const context = { global: 1, index: 1 };
  const result = await prepareUploadJobs(f.source, { ...settings, rename: '{global}/{index}' }, {
    dependencies: f.dependencies, context, onPlan: async () => { context.global = 10; context.index = 3; },
  });
  assert.deepEqual(result.jobs.map(job => job.metadata.title), ['Part 1 10/3', 'Part 2 11/4']);
  assert.deepEqual(result.job.templateContext, { filename: 'sample', folder: path.basename(f.directory), global: 10, index: 3 });
});
