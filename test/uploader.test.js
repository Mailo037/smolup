import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { SmolishApi, ApiError } from '../src/api.js';
import { fingerprint, publishJob, transferParts } from '../src/uploader.js';
import { parseArgs } from '../src/cli.js';
import { normalizeCookie } from '../src/auth.js';

const ID = '22749640277360641';
const bytes = Buffer.from('sample-video-bytes-that-span-multiple-parts');
const cookie = 'smolish.session_token=test-secret';

async function fixture(t, { failedPart = false, completeDisconnect = false, pending = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'prepared.mp4');
  await writeFile(file, bytes);
  let video = { id: ID, status: 'uploading', visibility: 'private', title: 'original.mp4', description: 'Keep this description' };
  const uploaded = new Map(), requests = [], stored = [];
  let creates = 0, completes = 0, partFailures = 0;
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const content = Buffer.concat(body);
    requests.push({ url: req.url, method: req.method, cookie: req.headers.cookie, content });
    const send = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url.startsWith('/storage/')) {
      if (failedPart && partFailures++ === 0) return send({}, 500);
      uploaded.set(Number(req.url.split('/').at(-1)), content);
      return send({});
    }
    if (req.headers.cookie !== cookie) return send({}, 401);
    if (req.url === '/api/auth/get-session') return send({ user: { id: '123', name: 'System' } });
    if (req.url === '/api/videos' && req.method === 'POST') {
      creates++;
      return send({ video, partSize: 7, partCount: Math.ceil(bytes.length / 7) });
    }
    if (req.url === `/api/videos?ids=${ID}`) return send({ items: [video] });
    if (req.url === `/api/videos/${ID}` && req.method === 'PATCH') {
      video = { ...video, ...JSON.parse(content) };
      return send({ video });
    }
    if (req.url === `/api/videos/${ID}/parts?sign=1`) {
      const count = Math.ceil(bytes.length / 7);
      return send({ partSize: 7, partCount: count, uploaded: [...uploaded.keys()],
        missing: Array.from({ length: count }, (_, i) => i + 1).filter(i => !uploaded.has(i)),
        urls: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, `${origin}/storage/${i + 1}`])) });
    }
    if (req.url === `/api/videos/${ID}/complete`) {
      completes++;
      video.status = pending ? 'processing' : 'ready';
      if (completeDisconnect) { req.socket.destroy(); return; }
      return send({ video });
    }
    return send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = new SmolishApi({ cookie, origin, allowLocal: true });
  const job = { id: 'local-test', directory, prepared: file, filename: 'original.mp4', sha256: await fingerprint(file), stage: 'prepared',
    metadata: { title: ' ', visibility: 'public' } };
  return { api, job, uploaded, requests, stored, save: async j => stored.push(structuredClone(j)),
    get video() { return video; }, set video(v) { video = v; },
    get creates() { return creates; }, get completes() { return completes; } };
}

test('multipart wire protocol preserves bytes, large string ID, description and exact blank title', async t => {
  const f = await fixture(t, { failedPart: true });
  assert.equal((await f.api.checkAuth()).name, 'System');
  const output = await publishJob(f.api, f.job, { save: f.save, wait: async () => {} });
  assert.equal(output.status, 'uploaded');
  assert.equal(output.videoId, ID);
  assert.equal(f.creates, 1);
  assert.equal(f.video.title, ' ');
  assert.equal(f.video.visibility, 'public');
  assert.equal(f.video.description, 'Keep this description');
  assert.deepEqual(Buffer.concat([...f.uploaded.values()]), bytes);
  assert.ok(f.requests.filter(r => r.url.startsWith('/storage/')).every(r => !r.cookie));
  const create = JSON.parse(f.requests.find(r => r.method === 'POST' && r.url === '/api/videos').content);
  assert.deepEqual(create, { filename: 'original.mp4', sizeBytes: bytes.length, contentType: 'video/mp4' });
  assert.ok(f.stored.some(j => j.videoId === ID && j.stage === 'uploading'));
  assert.equal(f.job.stage, 'done');
});

test('resume uploads only missing parts and does not create a new draft', async t => {
  const f = await fixture(t);
  f.job.videoId = ID;
  f.job.stage = 'uploading';
  f.uploaded.set(1, bytes.subarray(0, 7));
  await publishJob(f.api, f.job, { save: f.save, wait: async () => {} });
  assert.equal(f.creates, 0);
  assert.equal(f.requests.filter(r => r.url === '/storage/1').length, 0);
  assert.deepEqual(Buffer.concat([...f.uploaded.values()]), bytes);
});

test('lost completion response is recovered through server status without a second completion', async t => {
  const f = await fixture(t, { completeDisconnect: true });
  await publishJob(f.api, f.job, { save: f.save, wait: async () => {} });
  assert.equal(f.completes, 1);
  assert.equal(f.creates, 1);
});

test('processing timeout leaves an existing video resumable and private', async t => {
  const f = await fixture(t, { pending: true });
  await assert.rejects(publishJob(f.api, f.job, { save: f.save, timeoutMs: 0 }), /still processing/);
  assert.equal(f.job.videoId, ID);
  assert.equal(f.video.visibility, 'private');
  f.video = { ...f.video, status: 'ready' };
  await publishJob(f.api, f.job, { save: f.save });
  assert.equal(f.creates, 1);
  assert.equal(f.completes, 1);
  assert.equal(f.video.visibility, 'public');
});

test('an uncertain create is journaled and never automatically repeated', async t => {
  const f = await fixture(t);
  f.api.createDraft = async () => { throw new ApiError('network', 0); };
  await assert.rejects(publishJob(f.api, f.job, { save: f.save }), /network/);
  assert.equal(f.job.stage, 'creation-uncertain');
  assert.equal(f.job.videoId, undefined);
  await assert.rejects(publishJob(f.api, f.job, { save: f.save }), /Check Smolish Studio/);
});

test('changed media and malformed part plans are rejected before transmission', async t => {
  const f = await fixture(t);
  await writeFile(f.job.prepared, 'modified');
  await assert.rejects(publishJob(f.api, f.job, { save: f.save }), /has changed/);
  assert.equal(f.creates, 0);
  await assert.rejects(transferParts(f.api, ID, f.job.prepared,
    { partSize: 2, partCount: 4, uploaded: [1], missing: [1, 2, 3] }), /multipart/);
  assert.equal(f.requests.length, 0);
});

test('no success is reported when the server normalizes the one-space title', async t => {
  const f = await fixture(t);
  const metadata = f.api.metadata.bind(f.api);
  f.api.metadata = async (id, fields) => metadata(id, { ...fields, title: '' });
  await assert.rejects(publishJob(f.api, f.job, { save: f.save }), /not confirmed/);
  assert.notEqual(f.job.stage, 'done');
});

test('HTTP limits stop instead of generating further drafts; errors never echo credentials', async () => {
  let calls = 0;
  const api = new SmolishApi({ cookie, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: cookie }), { status: 429 });
  } });
  await assert.rejects(api.createDraft({ filename: 'file.mp4', sizeBytes: 100 }), e => e.status === 429 && !e.message.includes(cookie));
  assert.equal(calls, 1);
});

test('CLI parses the requested single-link command and rejects accidental bulk or invalid offsets', () => {
  const options = parseArgs(['https://example.com/video', '--start', '12.5', '--json']);
  assert.equal(options.command, 'upload');
  assert.equal(options.source, 'https://example.com/video');
  assert.equal(options.overrides.start, 12.5);
  assert.equal(options.json, true);
  assert.throws(() => parseArgs(['--start', '-1', 'file.mp4']), /greater than or equal/);
  assert.throws(() => parseArgs(['one.mp4', 'two.mp4']), /exactly one/);
  assert.throws(() => parseArgs(['resume', 'id', '--dry-run']), /not supported/);
  assert.equal(normalizeCookie('Cookie: session=abc; other=xyz'), 'session=abc; other=xyz');
  assert.throws(() => normalizeCookie('session=abc\nInjected: value'), /Cookie/);
});

test('fresh jobs default to Private and explicit title, visibility and description survive the multipart flow', async t => {
  const defaults = await fixture(t);
  delete defaults.job.metadata;
  const privateResult = await publishJob(defaults.api, defaults.job, { save: defaults.save, wait: async () => {} });
  assert.equal(privateResult.visibility, 'private');
  assert.equal(defaults.video.title, ' ');
  assert.equal(defaults.video.description, 'Keep this description');
  const custom = await fixture(t);
  custom.job.metadata = { title: 'A named clip', visibility: 'unlisted', description: 'Custom description' };
  const result = await publishJob(custom.api, custom.job, { save: custom.save, wait: async () => {} });
  assert.equal(result.visibility, 'unlisted');
  assert.equal(result.title, 'A named clip');
  assert.equal(result.video.description, 'Custom description');
  assert.deepEqual(result, await publishJob(custom.api, custom.job, { save: custom.save }));
  assert.equal(custom.creates, 1);
});
