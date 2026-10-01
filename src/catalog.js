import { videoSummary } from './api.js';

export async function listAccountVideos(api, filters, { all = false, signal } = {}) {
  const items = [], seen = new Set();
  let page = filters.page, total = null, pages = 0;
  while (true) {
    signal?.throwIfAborted();
    const data = await api.listVideos({ ...filters, page });
    if (!Array.isArray(data.items)) throw new Error('Smolish returned an invalid video list.');
    total = Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : null;
    pages++;
    const before = items.length;
    for (const raw of data.items) {
      const video = videoSummary(raw);
      if (!seen.has(video.id)) { seen.add(video.id); items.push(video); }
    }
    if (!all || !data.items.length || (total !== null ? page * filters.limit >= total : data.items.length < filters.limit)) break;
    if (items.length === before) throw new Error('Smolish repeated a page; video listing stopped.');
    if (pages >= 1000) throw new Error('Too many pages. Use filters or explicit pagination.');
    page++;
  }
  return { status: 'ok', items, count: items.length, total, page: filters.page, limit: filters.limit,
    pagesFetched: pages, all, filters: { visibility: filters.visibility || null, status: filters.status || null, sort: filters.sort, order: filters.dir } };
}
