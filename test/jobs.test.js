import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createJob, JOB_ID, listJobs, loadJob } from '../src/jobs.js';
import { jobsDirectory } from '../src/paths.js';

async function isolated(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smolup-jobs-'));
  const previous = process.env.SMOLUP_HOME;
  process.env.SMOLUP_HOME = root;
  try { return await work(root); }
  finally {
    if (previous === undefined) delete process.env.SMOLUP_HOME;
    else process.env.SMOLUP_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('new jobs use six-character VEO-format IDs and retain independent journals', () => isolated(async () => {
  const jobs = await Promise.all(Array.from({ length: 24 }, (_, index) => createJob(`video-${index}.mp4`, index)));
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length);
  for (const [index, job] of jobs.entries()) {
    assert.match(job.id, JOB_ID);
    assert.equal(job.directory, path.join(jobsDirectory(), job.id));
    const saved = await loadJob(job.id);
    assert.equal(saved.source, `video-${index}.mp4`);
    assert.equal(saved.start, index);
  }
}));

test('atomic allocation retries collisions without changing old journals', () => isolated(async () => {
  const old = await createJob('original.mp4', 0, { generateId: () => 'abc123' });
  const originalJournal = await readFile(path.join(old.directory, 'job.json'), 'utf8');
  const ids = ['abc123', 'xyz456'];
  const next = await createJob('next.mp4', 5, { generateId: () => ids.shift() });
  assert.equal(next.id, 'xyz456');
  assert.equal(await readFile(path.join(old.directory, 'job.json'), 'utf8'), originalJournal);
  assert.equal((await loadJob(next.id)).source, 'next.mp4');
  let attempts = 0;
  await assert.rejects(createJob('no-space.mp4', 0, { generateId: () => { attempts++; return 'abc123'; } }), /allocate a free/);
  assert.equal(attempts, 128);
}));

test('simultaneous reservations of the same ID cannot share a directory', () => isolated(async () => {
  const contender = alternative => {
    let attempt = 0;
    return createJob(`${alternative}.mp4`, 0, { generateId: () => attempt++ === 0 ? 'same00' : alternative });
  };
  const [first, second] = await Promise.all([contender('first1'), contender('second')]);
  assert.notEqual(first.id, second.id);
  assert.equal(new Set([first.id, second.id]).has('same00'), true);
  assert.equal((await loadJob(first.id)).source, 'first1.mp4');
  assert.equal((await loadJob(second.id)).source, 'second.mp4');
}));

test('legacy UUID jobs remain resumable and derive file paths from the requested ID', () => isolated(async () => {
  const id = 'a5c645fb-069c-4aac-b141-abf412e44432';
  const directory = path.join(jobsDirectory(), id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'job.json'), JSON.stringify({ id: '../other', directory: 'other', prepared: 'elsewhere',
    source: 'legacy.mp4', stage: 'prepared', createdAt: '2026-09-30T12:00:00.000Z' }));
  const loaded = await loadJob(id);
  assert.equal(loaded.id, id);
  assert.equal(loaded.directory, directory);
  assert.equal(loaded.prepared, path.join(directory, 'prepared.mp4'));
  assert.equal(loaded.metadata.visibility, 'public');
  const fresh = await createJob('fresh.mp4', 0);
  const listed = await listJobs();
  assert.equal(listed.total, 2);
  assert.equal(listed.jobs.some(job => job.id === fresh.id), true);
  assert.equal(listed.jobs.some(job => job.id === id), true);
}));

test('invalid IDs and malformed journals are rejected before loading paths', () => isolated(async () => {
  for (const invalid of ['../bad', '..\\bad', 'ABC123', 'five5', 'seven77', '', null, 123456, 'x/y123', 'a'.repeat(36),
    'abc123\n', 'a5c645fb-069c-4aac-b141-abf412e44432\n']) {
    await assert.rejects(loadJob(invalid), /valid local job ID/);
  }
  await assert.rejects(createJob('file.mp4', 0, { generateId: () => '../bad' }), /six lowercase/);
  const directory = path.join(jobsDirectory(), 'bad000');
  await mkdir(directory, { recursive: true });
  for (const contents of ['null', '[]', '123', '{broken']) {
    await writeFile(path.join(directory, 'job.json'), contents);
    await assert.rejects(loadJob('bad000'), /not found or damaged/);
  }
}));

test('a valid-looking job directory cannot link to a journal outside the jobs folder', () => isolated(async root => {
  const outside = path.join(root, 'other-journals');
  await mkdir(outside);
  await writeFile(path.join(outside, 'job.json'), JSON.stringify({ source: 'foreign.mp4', stage: 'prepared' }));
  await mkdir(jobsDirectory(), { recursive: true });
  await symlink(outside, path.join(jobsDirectory(), 'link00'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadJob('link00'), /not found or damaged/);
  assert.equal((await listJobs()).skipped, 1);
}));
