import path from 'node:path';
import { mkdir, rm, stat, lstat } from 'node:fs/promises';
import { createJob, loadJob, saveJob } from './jobs.js';
import { downloadVideo, mediaTools, prepareVideo, probe } from './media.js';
import { exportVideo } from './export.js';
import { fingerprint } from './uploader.js';
import { metadataFromSettings, validateSetting } from './settings.js';

const VARIABLES = new Set(['filename', 'folder', 'global', 'index', 'part', 'parts']);
const PARENT_STAGES = new Set(['prepared', 'uploading', 'processing', 'done']);

export function planClips(sourceDuration, { start = 0, duration = 60, split = false, splitThreshold = 90 } = {}) {
  validateSetting('start', start);
  validateSetting('duration', duration);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('The source duration must be a positive number.');
  if (typeof split !== 'boolean') throw new Error('Split must be true or false.');
  if (!Number.isFinite(splitThreshold) || splitThreshold < 60) throw new Error('Split threshold must be at least 60 seconds.');
  if (start >= sourceDuration) throw new Error('The start position is beyond the end of the video.');
  const remaining = sourceDuration - start;
  const count = split && remaining >= splitThreshold ? Math.ceil(remaining / duration) : 1;
  if (count > 10000) throw new Error('A split upload cannot contain more than 10,000 clips.');
  return Array.from({ length: count }, (_, index) => ({ part: index + 1, parts: count,
    start: start + index * duration, duration: Math.min(duration, remaining - index * duration) }));
}

function ordinal(value, fallback = 1) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Upload counters must be positive safe integers.');
  return number;
}

export function renderTitle(template = ' ', { filename = '', folder = '', global = 1, index = 1, part = 1, parts = 1,
  partLabel = 'prefix' } = {}) {
  validateSetting('rename', template);
  if (!['prefix', 'suffix', 'none'].includes(partLabel)) throw new Error('Part label must be prefix, suffix or none.');
  global = ordinal(global); index = ordinal(index); part = ordinal(part); parts = ordinal(parts);
  if (part > parts) throw new Error('The part number cannot exceed the number of clips.');
  const values = { filename, folder, global, index, part, parts };
  let title = template.replace(/\{([^{}]+)\}/g, (_, key) => {
    if (!VARIABLES.has(key)) throw new Error(`Unknown title variable "{${key}}". Available: ${[...VARIABLES].map(name => `{${name}}`).join(', ')}.`);
    return String(values[key]);
  });
  if (parts > 1 && partLabel !== 'none' && !template.includes('{part}')) {
    const label = `Part ${part}`;
    title = !title.trim() ? label : partLabel === 'prefix' ? `${label} ${title}` : `${title} ${label}`;
  }
  return validateSetting('rename', title);
}

function templateContext(source, filename, context = {}) {
  const isUrl = /^https?:\/\//i.test(source);
  const values = { filename: context.filename ?? path.parse(filename).name,
    folder: context.folder ?? (isUrl ? '' : path.basename(path.dirname(path.resolve(source)))),
    global: ordinal(context.global), index: ordinal(context.index) };
  if (typeof values.filename !== 'string' || typeof values.folder !== 'string') throw new Error('Filename and folder template values must be strings.');
  return values;
}

function clipMetadata(settings, context, clip) {
  return metadataFromSettings({ ...settings, rename: renderTitle(settings.rename, { ...context,
    global: ordinal(context.global + clip.part - 1), index: ordinal(context.index + clip.part - 1),
    part: clip.part, parts: clip.parts, partLabel: settings.partLabel ?? 'prefix' }) });
}

async function removeDownload(job, directory) {
  const expected = path.resolve(job.directory, 'download');
  if (path.resolve(directory) !== expected || path.dirname(expected) !== path.resolve(job.directory)
    || (await lstat(expected)).isSymbolicLink()) throw new Error('Unexpected temporary download directory.');
  await rm(expected, { recursive: true, force: true });
}

/** Prepare every clip before returning: callers can check aggregate quota before creating any remote drafts. */
export async function prepareUploadJobs(source, settings, { signal, step, log = () => {}, onDownloadLine, context = {},
  onJobCreated, onPlan, dependencies = {} } = {}) {
  const deps = { createJob, saveJob, downloadVideo, mediaTools, prepareVideo, probe, fingerprint, exportVideo, ...dependencies };
  const work = step || (async (label, fn) => { log(`${label}…`); return fn(); });
  const isUrl = /^https?:\/\//i.test(source);
  if (!isUrl && !(await stat(path.resolve(source))).isFile()) throw new Error('Video file not found.');
  const job = await deps.createJob(source, settings.start ?? 0);
  await onJobCreated?.(job);
  job.settings = { ...settings };
  await deps.saveJob(job);
  log(`Job: ${job.id}`);
  const directory = path.join(job.directory, 'download');
  let input;
  if (isUrl) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    input = await work('Downloading video with VEO', () => deps.downloadVideo(source, directory, {
      start: settings.start, duration: settings.split ? null : settings.duration,
      quality: settings.quality, signal, onDownloadLine }));
    input = path.resolve(input);
    const relative = path.relative(path.resolve(directory), input);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('VEO returned a video outside the temporary download directory.');
    }
  } else input = path.resolve(source);
  const filename = path.basename(input);
  const tools = await work('Loading FFmpeg', () => deps.mediaTools(signal));
  const sourceInfo = await work('Inspecting source video', () => deps.probe(input, tools, signal));
  const clips = planClips(sourceInfo.duration, { ...settings, start: isUrl && !settings.split ? 0 : settings.start ?? 0 });
  await onPlan?.(clips.length, { job, clips });
  const names = templateContext(source, filename, context);
  job.templateContext = names;
  job.inputDuration = sourceInfo.duration;
  job.filename = filename;
  job.metadata = clipMetadata(settings, names, clips[0]);
  const batch = clips.length > 1;
  if (batch) {
    job.kind = 'batch';
    job.children = [];
    job.partCount = clips.length;
    job.sizeBytes = 0;
    job.durationSeconds = 0;
  }
  await deps.saveJob(job);
  const jobs = [];
  for (const clip of clips) {
    signal?.throwIfAborted();
    const child = batch ? await deps.createJob(source, clip.start) : job;
    if (batch) {
      child.parentId = job.id;
      child.settings = { ...settings };
      child.templateContext = names;
      child.metadata = clipMetadata(settings, names, clip);
      child.filename = `${path.parse(filename).name}-Part-${clip.part}.mp4`;
      job.children.push(child.id);
      await deps.saveJob(job);
    }
    child.part = clip.part;
    child.parts = clip.parts;
    child.clipStart = clip.start;
    child.clipDuration = clip.duration;
    child.prepared = path.join(child.directory, 'prepared.mp4');
    await deps.saveJob(child);
    const prepared = await work(batch ? `Preparing Part ${clip.part} of ${clip.parts}` : 'Preparing video', () => deps.prepareVideo(input, child.prepared,
      { start: clip.start, duration: clip.duration, signal, tools }));
    child.durationSeconds = prepared.duration;
    child.sizeBytes = prepared.sizeBytes;
    child.sha256 = await work(batch ? `Checking Part ${clip.part}` : 'Checking prepared video', () => deps.fingerprint(child.prepared));
    child.stage = 'prepared';
    await deps.saveJob(child);
    if (settings.output) {
      child.output = await work(batch ? `Saving Part ${clip.part}` : 'Saving local copy', () => deps.exportVideo(child.prepared, settings.output, child.filename));
      await deps.saveJob(child);
    }
    jobs.push(child);
    if (batch) {
      job.sizeBytes += child.sizeBytes;
      job.durationSeconds += child.durationSeconds;
      await deps.saveJob(job);
    }
  }
  if (batch) {
    job.stage = 'prepared';
    job.preparedAt = new Date().toISOString();
    await deps.saveJob(job);
  }
  if (isUrl) await removeDownload(job, directory);
  return { job, jobs, batch };
}

/** Read the persisted plan without re-cutting sources or recreating remote drafts. */
export async function loadUploadJobs(job, { load = loadJob } = {}) {
  if (job.kind !== 'batch') return [job];
  if (!PARENT_STAGES.has(job.stage) || !Array.isArray(job.children) || !job.children.length
    || job.children.length !== job.partCount || new Set(job.children).size !== job.children.length) {
    throw new Error('Batch preparation was incomplete. Run the original video URL or file again.');
  }
  const jobs = [];
  for (const [index, id] of job.children.entries()) {
    const child = await load(id);
    if (child.parentId !== job.id || child.part !== index + 1 || child.parts !== job.partCount
      || child.stage === 'preparing' || !child.sha256) throw new Error('The batch contains an incomplete or damaged clip.');
    jobs.push(child);
  }
  return jobs;
}
