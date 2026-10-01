import test from 'node:test';
import assert from 'node:assert/strict';
import { storageFromPage, normalizeStorage, evaluateQuota, quotaPreflight, QuotaError } from '../src/storage.js';

const counters = { tier: 'new', quotaBytes: 1024, usedBytes: 700, dailyVideoLimit: 500, dailyVideoBytes: 400 };
const flight = text => `<script nonce="test">self.__next_f.push(${JSON.stringify([1, text])})</script>`;
const page = storage => `<html>${flight(`5:["$","$L1a",null,{"initial":${JSON.stringify(storage)}}]\n`)}</html>`;
test('storage page reads live counters rather than assumed tier limits, and never executes scripts', () => {
  const html = `<script>throw new Error('must not execute')</script>${page({ ...counters, application: { message: 'braces } with \\" quotes' } })}`;
  const storage = storageFromPage(html);
  assert.equal(storage.quotaBytes, 1024);
  assert.equal(storage.remainingBytes, 324);
  assert.equal(storage.dailyRemainingBytes, 100);
  const text = `5:["$","$L1a",null,{"initial":${JSON.stringify(counters)}}]`;
  assert.equal(storageFromPage(flight(text.slice(0, 50)) + flight(text.slice(50))).dailyVideoLimit, 500);
  assert.throws(() => storageFromPage('<html>Sign in</html>'), /not found/);
  assert.throws(() => normalizeStorage({ ...counters, dailyVideoBytes: undefined }), /dailyVideoBytes/);
});
test('aggregate quota covers both total storage and daily bytes, accepting an exact fit', () => {
  const storage = normalizeStorage(counters);
  assert.equal(evaluateQuota(storage, 100).allowed, true);
  assert.deepEqual(evaluateQuota(storage, 101).reasons.length, 1);
  assert.equal(evaluateQuota(storage, 325).reasons.length, 2);
});
test('quota stops before drafts, prompts only when interactive and supports an explicit normal attempt', async () => {
  const api = { storagePage: async () => page(counters) };
  const jobs = [{ stage: 'prepared', sizeBytes: 60 }, { stage: 'prepared', sizeBytes: 60 }];
  let prompts = 0;
  await assert.rejects(quotaPreflight(api, jobs, { confirm: async () => { prompts++; return true; } }), QuotaError);
  assert.equal(prompts, 0);
  await assert.rejects(quotaPreflight(api, jobs, { interactive: true, confirm: async () => { prompts++; return false; } }), QuotaError);
  assert.equal(prompts, 1);
  assert.equal((await quotaPreflight(api, jobs, { interactive: true, confirm: async () => true })).overridden, true);
  assert.equal((await quotaPreflight(api, jobs, { tryAnyway: true })).overridden, true);
});
test('already reserved drafts are excluded and unavailable counters remain unknown', async () => {
  const api = { storagePage: async () => { throw new Error('offline'); } };
  assert.equal((await quotaPreflight(api, [{ videoId: '123', stage: 'processing', sizeBytes: 200 }])).skipped, 'Existing drafts are resumed under server limits');
  await assert.rejects(quotaPreflight(api, [{ stage: 'prepared', sizeBytes: 10 }]), error => error.quota.unavailable && error.quota.storage === null);
  const attempted = await quotaPreflight(api, [{ stage: 'prepared', sizeBytes: 10 }], { tryAnyway: true });
  assert.equal(attempted.overridden, true);
  assert.equal(attempted.allowed, false);
});
