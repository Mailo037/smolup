import { saveJob } from './jobs.js';
import { stat } from 'node:fs/promises';
import { publishJob, fingerprint } from './uploader.js';
import { MAX_BYTES } from './api.js';
import { quotaPreflight } from './storage.js';
import { exportVideo } from './export.js';
import { renderTitle } from './split.js';

export function preparedResult(parent, jobs) {
  const item = job => ({ status: 'prepared', jobId: job.id, file: job.prepared, output: job.output || null,
    durationSeconds: job.durationSeconds, sizeBytes: job.sizeBytes, metadata: job.metadata });
  if (parent.kind !== 'batch') return item(parent);
  return { status: 'prepared', jobId: parent.id, partCount: jobs.length, sizeBytes: parent.sizeBytes,
    durationSeconds: parent.durationSeconds, items: jobs.map(item) };
}

export async function overrideJobMetadata(parent, jobs, overrides) {
  if (!Object.keys(overrides).length) return;
  if (parent.stage === 'done') throw new Error(`This job is complete. Use smolup edit ${jobs[0].videoId} to change its metadata.`);
  for (const child of jobs) {
    if (child.stage === 'done') continue;
    const fields = { ...overrides };
    if (fields.title !== undefined && child.templateContext) fields.title = renderTitle(fields.title, {
      ...child.templateContext, global: (child.templateContext.global || 1) + (child.part || 1) - 1,
      index: (child.templateContext.index || 1) + (child.part || 1) - 1,
      part: child.part || 1, parts: child.parts || 1, partLabel: child.settings?.partLabel || 'prefix' });
    child.metadata = { ...child.metadata, ...fields };
    await saveJob(child);
  }
}

export async function publishUploadJobs(api, parent, jobs, options = {}) {
  const { signal, step, log = () => {}, progress, tryAnyway, interactive, confirm } = options;
  const work = step || (async (_label, fn) => fn());
  for (const child of jobs) {
    if (!child.videoId && ['creating', 'creation-uncertain'].includes(child.stage)) {
      throw new Error('The draft response was uncertain. Check Smolish Studio before starting another upload.');
    }
    if (child.stage === 'preparing' || !child.sha256) throw new Error('Preparation was incomplete. Run the original video URL or file again.');
    if (child.stage !== 'done') {
      const current = child.videoId ? await api.getVideo(child.videoId) : null;
      if (current && !['draft', 'uploading', 'queued', 'processing', 'ready'].includes(current.status)) {
        throw new Error('An existing clip is not in a resumable server state. Check Smolish Studio.');
      }
      if (!current || ['draft', 'uploading'].includes(current.status)) {
        const size = (await stat(child.prepared)).size;
        if (!size || size > MAX_BYTES || size !== child.sizeBytes || await fingerprint(child.prepared) !== child.sha256) {
          throw new Error('A prepared clip has changed. Restore its prepared file before uploading this job.');
        }
      }
    }
    if (child.stage !== 'done' && child.settings?.output && !child.output) {
      child.output = await work('Saving local copy', () => exportVideo(child.prepared, child.settings.output, child.filename));
      await saveJob(child);
    }
  }
  const quota = await work('Checking account storage and daily limits', () => quotaPreflight(api, jobs,
    { tryAnyway, interactive, confirm, signal, log }));
  const batch = parent.kind === 'batch';
  if (batch && parent.stage !== 'done') { parent.stage = 'uploading'; await saveJob(parent); }
  const items = [];
  for (const child of jobs) {
    signal?.throwIfAborted();
    // The first check covers the entire batch; later checks refresh after each draft reserves its bytes.
    if (batch && items.length && !child.videoId && child.stage !== 'done') {
      await work('Refreshing account limits', () => quotaPreflight(api, jobs.slice(items.length),
        { tryAnyway: tryAnyway || quota.overridden, interactive, confirm, signal, log }));
    }
    const result = await publishJob(api, child, { signal, save: saveJob, step, log, progress });
    items.push({ ...result, jobId: child.id, output: child.output || null, part: child.part || 1 });
    if (batch) { parent.completedCount = items.length; await saveJob(parent); }
  }
  if (!batch) return { ...items[0], jobId: parent.id };
  parent.stage = 'done';
  parent.completedAt ||= new Date().toISOString();
  parent.result = { status: 'uploaded', jobId: parent.id, partCount: items.length, items,
    sizeBytes: parent.sizeBytes, durationSeconds: parent.durationSeconds };
  await saveJob(parent);
  return parent.result;
}
