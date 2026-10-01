import test from 'node:test';
import assert from 'node:assert/strict';
import { listAccountVideos } from '../src/catalog.js';
import { SmolishApi, videoSummary } from '../src/api.js';

const ID = '22749640277360641';
const cookie = 'smolish.session_token=catalog-test-secret';
const filters = { page: 1, limit: 2, sort: 'views', dir: 'desc', visibility: 'private', status: 'ready' };
const rawVideo = overrides => ({ id: ID, title: ' ', description: 'Original description', visibility: 'private', status: 'ready',
  durationSeconds: 59.5, sizeBytes: 12345, viewsCount: 25, playsCount: 30, likesCount: 7, commentsCount: 3,
  views: 999, plays: 999, likes: 999, comments: 999, createdAt: '2026-10-01T10:00:00.000Z', ...overrides });

test('catalog schema uses the actual server counters, string IDs and canonical video URLs', () => {
  const video = videoSummary(rawVideo());
  assert.deepEqual(video, { id: ID, title: ' ', description: 'Original description', visibility: 'private', status: 'ready',
    durationSeconds: 59.5, sizeBytes: 12345, views: 25, plays: 30, likes: 7, comments: 3,
    createdAt: '2026-10-01T10:00:00.000Z', url: `https://smolish.com/v/${ID}`, studioUrl: `https://smolish.com/studio/video/${ID}` });
  assert.throws(() => videoSummary(rawVideo({ id: 22749640277360641 })), /unsafe numeric video ID/);
});

test('missing or invalid counters are null while a real zero stays zero', () => {
  const video = videoSummary({ id: '123', viewsCount: 0, playsCount: '12', likesCount: NaN, commentsCount: Infinity });
  assert.equal(video.views, 0);
  for (const key of ['plays', 'likes', 'comments', 'durationSeconds', 'sizeBytes']) assert.equal(video[key], null);
  assert.equal(video.createdAt, null);
});

test('all account pages retain filters and deduplicate IDs before presenting metrics', async () => {
  const calls = [];
  const api = { listVideos: async query => {
    calls.push(query);
    return query.page === 1 ? { total: 4, items: [rawVideo(), rawVideo({ id: '123' })] }
      : { total: 4, items: [rawVideo({ id: '123' }), rawVideo({ id: '456', viewsCount: 2 })] };
  } };
  const result = await listAccountVideos(api, filters, { all: true });
  assert.deepEqual(calls, [{ ...filters, page: 1 }, { ...filters, page: 2 }]);
  assert.deepEqual(result.items.map(video => video.id), [ID, '123', '456']);
  assert.equal(result.count, 3);
  assert.equal(result.total, 4);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.all, true);
  assert.deepEqual(result.filters, { visibility: 'private', status: 'ready', sort: 'views', order: 'desc' });
});

test('listing one page uses the selected page and unknown totals end on a short page', async () => {
  let calls = 0;
  const one = await listAccountVideos({ listVideos: async query => {
    calls++;
    assert.equal(query.page, 3);
    return { total: 7, items: [rawVideo()] };
  } }, { ...filters, page: 3 });
  assert.equal(calls, 1);
  assert.equal(one.page, 3);
  const pages = [];
  const all = await listAccountVideos({ listVideos: async query => {
    pages.push(query.page);
    return { items: query.page === 1 ? [rawVideo(), rawVideo({ id: '123' })] : [rawVideo({ id: '456' })] };
  } }, filters, { all: true });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(all.total, null);
  assert.equal(all.count, 3);
});

test('catalog stops repeated pages, rejects malformed lists and honors cancellation before requests', async () => {
  let calls = 0;
  await assert.rejects(listAccountVideos({ listVideos: async () => {
    calls++;
    return { total: 10, items: [rawVideo(), rawVideo({ id: '123' })] };
  } }, filters, { all: true }), /repeated a page/);
  assert.equal(calls, 2);
  await assert.rejects(listAccountVideos({ listVideos: async () => ({ items: {} }) }, filters), /invalid video list/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled catalog'));
  await assert.rejects(listAccountVideos({ listVideos: async () => { throw new Error('must not request'); } }, filters, { signal: controller.signal }), /cancelled catalog/);
});

test('API collection and analytics routes encode only supported filters and use the account cookie', async () => {
  const requests = [];
  const api = new SmolishApi({ cookie, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ items: [rawVideo()], total: 1 }), { status: 200 });
  } });
  await api.listVideos(filters);
  const url = new URL(requests[0].url);
  assert.equal(url.origin, 'https://smolish.com');
  assert.equal(url.pathname, '/api/videos');
  assert.deepEqual(Object.fromEntries(url.searchParams), { page: '1', limit: '2', sort: 'views', dir: 'desc', visibility: 'private', status: 'ready' });
  assert.equal(requests[0].options.headers.Cookie, cookie);
  assert.equal(requests[0].options.redirect, 'error');
  await api.analytics(ID, 90);
  assert.equal(requests[1].url, `https://smolish.com/api/studio/analytics?days=90&videoId=${ID}`);
  await api.analytics(undefined, 7);
  assert.equal(requests[2].url, 'https://smolish.com/api/studio/analytics?days=7');
});

test('signed storage transfers receive no account headers and HTTP or network errors never echo cookies', async () => {
  let putRequest;
  const api = new SmolishApi({ cookie, fetchImpl: async (url, options) => {
    putRequest = { url, options };
    return new Response(null, { status: 200 });
  } });
  await api.putPart('https://storage.example/part?signature=secret', Buffer.from('video bytes'));
  assert.equal(putRequest.options.method, 'PUT');
  assert.equal(putRequest.options.headers, undefined);
  assert.equal(putRequest.options.redirect, 'error');
  for (const status of [401, 403, 429, 500]) {
    const failed = new SmolishApi({ cookie, fetchImpl: async () => new Response(JSON.stringify({ cookie }), { status }) });
    await assert.rejects(failed.listVideos(), error => error.status === status && !error.message.includes(cookie));
  }
  const disconnected = new SmolishApi({ cookie, fetchImpl: async () => { throw new Error(`Server echoed ${cookie}`); } });
  await assert.rejects(disconnected.listVideos(), error => error.status === 0 && !error.message.includes(cookie));
  await assert.rejects(api.putPart('https://user:password@storage.example/part', Buffer.from('x')), /invalid upload URL/);
});
