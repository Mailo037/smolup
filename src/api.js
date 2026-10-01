export const ORIGIN = 'https://smolish.com';
export const MAX_BYTES = 300 * 1024 * 1024;

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function videoId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('The server returned an unsafe numeric video ID.');
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) throw new Error('A numeric Smolish video ID is required.');
  return id;
}

export class SmolishApi {
  constructor({ cookie, signal, fetchImpl = fetch, origin = ORIGIN, allowLocal = false }) {
    if (origin !== ORIGIN && !(allowLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) {
      throw new Error('Invalid Smolish server.');
    }
    this.cookie = cookie;
    this.signal = signal;
    this.fetchImpl = fetchImpl;
    this.origin = origin;
    this.allowLocal = allowLocal;
  }

  async request(route, { method = 'GET', body, format = 'json' } = {}) {
    const headers = { Cookie: this.cookie, Origin: this.origin, Referer: `${this.origin}/studio`, Accept: format === 'html' ? 'text/html' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.any([this.signal || new AbortController().signal, AbortSignal.timeout(60000)]),
      });
    } catch {
      this.signal?.throwIfAborted();
      throw new ApiError('The Smolish request failed. Check your connection and cookie.', 0);
    }
    if (!response.ok) {
      const message = [401, 403].includes(response.status)
        ? 'Smolish denied access. Renew your cookie with smop setup and check the website in your browser.'
        : response.status === 429 ? 'Smolish reached a rate or account limit. Resume later.'
          : `Smolish returned HTTP ${response.status}.`;
      throw new ApiError(message, response.status);
    }
    try { return format === 'html' ? await response.text() : await response.json(); }
    catch { throw new ApiError(format === 'html' ? 'Smolish returned an unreadable storage page.' : 'Smolish returned a non-JSON response. Check the website and cookie.', response.status); }
  }

  async checkAuth() {
    const session = await this.request('/api/auth/get-session');
    if (!session?.user?.id) throw new Error('The Smolish cookie has expired. Run smop setup.');
    return { id: String(session.user.id), name: session.user.name || '' };
  }

  createDraft({ filename, sizeBytes, contentType = 'video/mp4' }) {
    return this.request('/api/videos', { method: 'POST', body: { filename, sizeBytes, contentType } });
  }

  parts(id) { return this.request(`/api/videos/${videoId(id)}/parts?sign=1`); }
  signPart(id, part) { return this.request(`/api/videos/${videoId(id)}/parts`, { method: 'POST', body: { partNumbers: [part] } }); }
  async complete(id) { return (await this.request(`/api/videos/${videoId(id)}/complete`, { method: 'POST' })).video; }
  async metadata(id, body) { return (await this.request(`/api/videos/${videoId(id)}`, { method: 'PATCH', body })).video; }
  async getVideo(id) {
    const data = await this.request(`/api/videos?ids=${videoId(id)}`);
    const video = data.items?.find(item => videoId(item.id) === videoId(id));
    if (!video) throw new Error('Video not found in your Smolish Studio.');
    return video;
  }

  listVideos({ visibility, status, page = 1, limit = 30, sort = 'date', dir = 'desc' } = {}) {
    const query = new URLSearchParams({ page: String(page), limit: String(limit), sort, dir });
    if (visibility) query.set('visibility', visibility);
    if (status) query.set('status', status);
    return this.request(`/api/videos?${query}`);
  }

  analytics(id, days = 28) {
    const query = new URLSearchParams({ days: String(days) });
    if (id) query.set('videoId', videoId(id));
    return this.request(`/api/studio/analytics?${query}`);
  }

  storagePage() { return this.request('/storage/apply', { format: 'html' }); }

  async putPart(url, bytes) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('The server returned an invalid upload URL.'); }
    if (parsed.username || parsed.password || (parsed.protocol !== 'https:'
      && !(this.allowLocal && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))) {
      throw new Error('The server returned an invalid upload URL.');
    }
    let response;
    try {
      // Signed storage URLs get only the video bytes, never the account Cookie.
      response = await this.fetchImpl(url, { method: 'PUT', body: bytes, redirect: 'error',
        signal: AbortSignal.any([this.signal || new AbortController().signal, AbortSignal.timeout(300000)]) });
    } catch {
      this.signal?.throwIfAborted();
      throw new ApiError('The video part could not be transferred.', 0);
    }
    if (!response.ok) throw new ApiError(`Video part upload returned HTTP ${response.status}.`, response.status);
    await response.body?.cancel();
  }
}

export function videoSummary(video) {
  const id = videoId(video.id);
  const metric = key => typeof video[key] === 'number' && Number.isFinite(video[key]) ? video[key] : null;
  return { id, title: video.title ?? '', description: video.description ?? '', visibility: video.visibility ?? null,
    status: video.status ?? null, durationSeconds: metric('durationSeconds'), sizeBytes: metric('sizeBytes'),
    views: metric('viewsCount'), plays: metric('playsCount'), likes: metric('likesCount'), comments: metric('commentsCount'),
    createdAt: video.createdAt ?? null, url: `${ORIGIN}/v/${id}`, studioUrl: `${ORIGIN}/studio/video/${id}` };
}
