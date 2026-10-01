import { open, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_BYTES, videoId, videoSummary } from './api.js';
import { DEFAULTS, metadataFromSettings, validateSetting } from './settings.js';

export async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function validateParts(parts, size) {
  if (!Number.isSafeInteger(parts.partSize) || parts.partSize <= 0
    || !Number.isSafeInteger(parts.partCount) || parts.partCount !== Math.ceil(size / parts.partSize)
    || !Array.isArray(parts.missing) || !Array.isArray(parts.uploaded)) {
    throw new Error('The server returned an incomplete multipart plan.');
  }
  const numbers = [...parts.missing, ...parts.uploaded];
  if (numbers.length !== parts.partCount || new Set(numbers).size !== numbers.length
    || numbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > parts.partCount)) {
    throw new Error('The server returned an invalid multipart plan.');
  }
}

export async function transferParts(api, id, file, plan, { signal, progress = () => {}, wait = delay } = {}) {
  const size = (await stat(file)).size;
  validateParts(plan, size);
  const handle = await open(file, 'r');
  let uploaded = plan.uploaded.reduce((sum, n) => sum + Math.min(plan.partSize, size - (n - 1) * plan.partSize), 0);
  progress(uploaded, size);
  try {
    for (const number of plan.missing) {
      signal?.throwIfAborted();
      const offset = (number - 1) * plan.partSize;
      const length = Math.min(plan.partSize, size - offset);
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const chunk = await handle.read(bytes, read, length - read, offset + read);
        if (!chunk.bytesRead) throw new Error('The video file changed during the upload.');
        read += chunk.bytesRead;
      }
      let url = plan.urls?.[number];
      for (let attempt = 0; ; attempt++) {
        if (!url) url = (await api.signPart(id, number)).urls?.[number];
        if (!url) throw new Error('Smolish did not return a URL for this video part.');
        try { await api.putPart(url, bytes); break; }
        catch (error) {
          signal?.throwIfAborted();
          const retryable = error.status === 0 || error.status === 403 || error.status >= 500;
          if (!retryable || attempt >= 2) throw error;
          if (error.status === 403) url = undefined;
          await wait(1000 * 2 ** attempt, undefined, { signal });
        }
      }
      uploaded += length;
      progress(uploaded, size);
    }
  } finally { await handle.close(); }
}

export async function publishJob(api, job, { save, signal, log = () => {}, step, progress, wait = delay, timeoutMs = 600000 } = {}) {
  const work = step || (async (label, fn) => { log(`${label}…`); return fn(); });
  if (job.stage === 'done') return job.result || { status: 'uploaded', videoId: job.videoId,
    visibility: job.metadata?.visibility || 'public', url: `https://smolish.com/v/${job.videoId}` };
  job.metadata ||= metadataFromSettings(DEFAULTS);
  validateSetting('rename', job.metadata.title);
  validateSetting('visibility', job.metadata.visibility);
  if (job.metadata.description !== undefined) validateSetting('description', job.metadata.description);
  if (!job.videoId && ['creating', 'creation-uncertain'].includes(job.stage)) throw new Error('The draft response was uncertain. Check Smolish Studio before starting another upload.');
  if (!job.videoId) {
    const size = (await stat(job.prepared)).size;
    if (size > MAX_BYTES || size === 0) throw new Error('Invalid video size.');
    if (await fingerprint(job.prepared) !== job.sha256) throw new Error('The prepared video has changed.');
    job.stage = 'creating';
    await save(job);
    let draft;
    try { draft = await work('Creating Smolish draft', () => api.createDraft({ filename: job.filename, sizeBytes: size })); }
    catch (error) {
      job.stage = [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status) ? 'prepared' : 'creation-uncertain';
      await save(job);
      throw error;
    }
    job.videoId = videoId(draft.video?.id);
    job.stage = 'uploading';
    await save(job);
  }
  const id = videoId(job.videoId);
  let current = await api.getVideo(id);
  if (current.status === 'failed') throw new Error('Smolish processing failed. Check the video in Studio.');
  if (['draft', 'uploading'].includes(current.status)) {
    if (await fingerprint(job.prepared) !== job.sha256) throw new Error('The prepared video has changed.');
    await api.metadata(id, { ...job.metadata, visibility: 'private' });
    const plan = await api.parts(id);
    await work('Uploading video', () => transferParts(api, id, job.prepared, plan, { signal, progress, wait }));
    job.stage = 'completing';
    await save(job);
    try { current = await work('Completing upload', () => api.complete(id)); }
    catch (error) {
      current = await api.getVideo(id);
      if (!['queued', 'processing', 'ready'].includes(current.status)) throw error;
    }
    job.stage = 'processing';
    await save(job);
  }
  await work('Processing on Smolish', async () => {
    const deadline = Date.now() + timeoutMs;
    while (current.status !== 'ready') {
      signal?.throwIfAborted();
      if (current.status === 'failed') throw new Error('Smolish processing failed. Check the video in Studio.');
      if (!['queued', 'processing'].includes(current.status)) throw new Error('Unknown video status. Check the video in Studio.');
      if (Date.now() >= deadline) throw new Error('Smolish is still processing the video. Resume this job later.');
      await wait(3000, undefined, { signal });
      current = await api.getVideo(id);
    }
  });
  await work(`Saving ${job.metadata.visibility} visibility and metadata`, async () => {
    await api.metadata(id, job.metadata);
    current = await api.getVideo(id);
    if (current.status !== 'ready' || current.visibility !== job.metadata.visibility || current.title !== job.metadata.title
      || (job.metadata.description !== undefined && current.description !== job.metadata.description)) {
      throw new Error('The requested visibility or metadata was not confirmed by Smolish. Check the video in Studio.');
    }
  });
  job.stage = 'done';
  job.completedAt = new Date().toISOString();
  job.result = { status: 'uploaded', videoId: id, visibility: current.visibility, title: current.title,
    url: `https://smolish.com/v/${id}`, video: videoSummary(current) };
  await save(job);
  await rm(job.prepared, { force: true }).catch(() => {});
  return job.result;
}
