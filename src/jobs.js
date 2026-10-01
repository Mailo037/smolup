import path from 'node:path';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { jobsDirectory, stateDirectory } from './paths.js';

// Match VEO's short run-ID format, while keeping upload journals independent.
export const JOB_ID = /^[0-9a-z]{6}$/;
const LEGACY_JOB_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ALLOCATION_ATTEMPTS = 128;
const newJobId = () => Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');

export async function saveJob(job) {
  const file = path.join(job.directory, 'job.json');
  await writeFile(`${file}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function createJob(source, start, { generateId = newJobId } = {}) {
  const root = jobsDirectory();
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt++) {
    const id = generateId();
    if (typeof id !== 'string' || id.length !== 6 || !JOB_ID.test(id)) throw new Error('Job IDs must contain six lowercase letters or digits.');
    const directory = path.join(root, id);
    // mkdir without recursive allocation is an atomic reservation: another
    // process or an old journal can never be silently reused or overwritten.
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const job = { id, directory, source, start, stage: 'preparing', createdAt: new Date().toISOString() };
    await saveJob(job);
    return job;
  }
  throw new Error('Could not allocate a free six-character job ID. Try again.');
}

export async function loadJob(id) {
  if (typeof id !== 'string' || !((id.length === 6 && JOB_ID.test(id)) || (id.length === 36 && LEGACY_JOB_ID.test(id)))) {
    throw new Error('A valid local job ID is required.');
  }
  const directory = path.join(jobsDirectory(), id);
  let job;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid job directory.');
    job = JSON.parse(await readFile(path.join(directory, 'job.json'), 'utf8'));
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('Invalid job journal.');
  }
  catch { throw new Error('Upload job not found or damaged.'); }
  // Paths are derived from the ID, rather than trusted from stored JSON.
  job.id = id;
  job.directory = directory;
  job.prepared = path.join(directory, 'prepared.mp4');
  // Existing 0.1 jobs retain their originally requested Public visibility.
  job.metadata ||= { title: ' ', visibility: 'public' };
  return job;
}

export async function acquireLock() {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  const file = path.join(stateDirectory(), 'upload.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The upload lock is damaged. Check upload.lock in the smolup cache.');
      try {
        process.kill(pid, 0);
        const busy = new Error('Another smolup upload is running. Wait for it to finish.');
        busy.code = 'UPLOAD_BUSY'; throw busy;
      }
      catch (problem) {
        if (problem.code !== 'ESRCH') throw problem;
        await rm(file, { force: true });
      }
    }
  }
  throw new Error('Could not acquire the upload lock. Try again.');
}

export async function listJobs(limit = 20) {
  let entries;
  try { entries = await readdir(jobsDirectory()); }
  catch (error) { if (error.code === 'ENOENT') return { jobs: [], skipped: 0, total: 0 }; throw error; }
  const jobs = [];
  let skipped = 0;
  for (const id of entries) {
    try {
      const job = await loadJob(id);
      jobs.push({ id, source: job.source, stage: job.stage, createdAt: job.createdAt,
        completedAt: job.completedAt || null, videoId: job.videoId || null, visibility: job.metadata.visibility,
        title: job.metadata.title, durationSeconds: job.durationSeconds ?? null, sizeBytes: job.sizeBytes ?? null,
        prepared: job.stage === 'done' || job.kind === 'batch' ? null : job.prepared, output: job.output || null,
        kind: job.kind || 'video', parentId: job.parentId || null, children: job.children || [], partCount: job.partCount || 1,
        url: job.videoId ? `https://smolish.com/v/${job.videoId}` : null });
    } catch { skipped++; }
  }
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { jobs: jobs.slice(0, limit), total: jobs.length, skipped };
}
