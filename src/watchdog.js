import path from 'node:path';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configDirectory, stateDirectory } from './paths.js';
import { DEFAULTS, validateSettings } from './settings.js';

const EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mts', '.m2ts', '.mpeg', '.mpg', '.3gp', '.ts']);
const RESERVED = new Set(['all', 'add', 'list', 'show', 'remove', 'rm', 'start', 'stop', 'status', 'retry']);
const emptyRegistry = () => ({ version: 1, watchdogs: {} });
const emptyState = () => ({ version: 1, globalCount: 0, watchdogs: {} });
const emptyJournal = () => ({ count: 0, seen: {}, ignored: {}, records: {} });
const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const fileKey = file => digest(normalized(file));
const within = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const details = error => String(error?.message || error || 'Upload failed.').replace(/[\r\n\0]/g, ' ').slice(0, 500);

export function watchdogName(name) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name || '') || RESERVED.has(name)) {
    throw new Error('Watchdog names use 1–31 lowercase letters, digits or hyphens, start with a letter, and cannot be command names.');
  }
  return name;
}

export function watchdogPaths(options = {}) {
  const configDir = path.resolve(options.configDir || configDirectory());
  const stateDir = path.resolve(options.stateDir || path.join(stateDirectory(), 'watchdogs'));
  return { config: path.join(configDir, 'watchdogs.json'), state: path.join(stateDir, 'state.json'),
    stateDir, mutex: path.join(stateDir, 'state.lock'), runner: path.join(stateDir, 'runner.lock') };
}

async function readJson(file, missing) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return missing();
    throw new Error(`Cannot read watchdog data: ${file}`);
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('A watchdog lock is damaged. Inspect the watchdog state directory.');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function readLock(file) {
  let lock;
  try { lock = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`A watchdog lock is damaged: ${file}`); }
  if (!lock || typeof lock.token !== 'string' || !alive(lock.pid)) return null;
  return lock;
}

async function acquireFileLock(file, data, { wait = false, signal } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = { pid: process.pid, token: randomUUID(), ...data };
  const deadline = Date.now() + (wait ? 3000 : 0);
  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(lock)); } finally { await handle.close(); }
      return { ...lock, async release() {
        let current;
        try { current = JSON.parse(await readFile(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.token === lock.token) await rm(file, { force: true });
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readJson(file, () => null);
      if (!current) continue;
      if (!alive(current.pid)) { await rm(file, { force: true }); continue; }
      if (wait && Date.now() < deadline) { await delay(25, undefined, { signal }); continue; }
      throw new Error(wait ? 'Watchdog data is busy. Try again.' : 'A watchdog runner is already active. Use smup watchdog status or stop.');
    }
  }
}

function checkRegistry(registry) {
  if (!registry || registry.version !== 1 || !registry.watchdogs || typeof registry.watchdogs !== 'object' || Array.isArray(registry.watchdogs)) {
    throw new Error('The watchdog configuration is damaged.');
  }
  for (const [name, record] of Object.entries(registry.watchdogs)) {
    watchdogName(name);
    if (!record || !path.isAbsolute(record.folder || '') || typeof record.recursive !== 'boolean' || typeof record.existing !== 'boolean') {
      throw new Error(`Watchdog "${name}" has an invalid folder or options.`);
    }
    seconds(record.interval, 'Interval', 0.1, 3600);
    seconds(record.stable, 'Stable delay', 0, 3600);
    snapshotSettings(record.settings);
  }
  return registry;
}

function checkState(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.globalCount) || state.globalCount < 0
      || !state.watchdogs || typeof state.watchdogs !== 'object' || Array.isArray(state.watchdogs)) throw new Error('The watchdog upload journal is damaged.');
  for (const [name, journal] of Object.entries(state.watchdogs)) {
    watchdogName(name);
    if (!journal || !Number.isSafeInteger(journal.count) || journal.count < 0 || !journal.seen || !journal.ignored || !journal.records) {
      throw new Error(`The journal for watchdog "${name}" is damaged.`);
    }
  }
  return state;
}

async function transaction(paths, callback, { registry = false, signal } = {}) {
  const lock = await acquireFileLock(paths.mutex, {}, { wait: true, signal });
  try {
    const file = registry ? paths.config : paths.state;
    const value = registry ? checkRegistry(await readJson(file, emptyRegistry)) : checkState(await readJson(file, emptyState));
    const result = await callback(value);
    await writeJson(file, value);
    return result;
  } finally { await lock.release(); }
}

export async function reserveGlobalUploads(count, options = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('The number of uploads must be a positive integer.');
  return transaction(watchdogPaths(options), state => {
    if (!Number.isSafeInteger(state.globalCount + count)) throw new Error('The global upload counter is exhausted.');
    const global = state.globalCount + 1;
    state.globalCount += count;
    return { global, index: global, parts: count };
  }, { signal: options.signal });
}

function seconds(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} must be ${minimum}–${maximum} seconds.`);
  return number;
}

function snapshotSettings(settings = DEFAULTS) {
  const { preset, ...values } = settings;
  const result = validateSettings(values);
  if (preset !== undefined && preset !== null && typeof preset !== 'string') throw new Error('The watchdog preset must be a name or null.');
  if (preset !== undefined) result.preset = preset;
  return result;
}

function statIdentity(file, stat) { return digest(`${normalized(file)}\0${stat.dev}\0${stat.ino}\0${stat.birthtimeMs}`); }
function statFingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`; }

async function rootFolder(folder) {
  const absolute = path.resolve(folder);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A watchdog folder must be an existing directory, without a symbolic link.');
  return realpath(absolute);
}

async function canonicalOutput(file, links = 0) {
  if (links > 40) throw new Error('The export output directory contains too many symbolic links.');
  let current = path.resolve(file);
  const missing = [];
  while (true) {
    try { return path.resolve(await realpath(current), ...missing); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const stat = await lstat(current).catch(problem => { if (['ENOENT', 'ENOTDIR'].includes(problem.code)) return null; throw problem; });
      if (stat?.isSymbolicLink()) {
        const target = path.resolve(path.dirname(current), await readlink(current));
        return canonicalOutput(path.resolve(target, ...missing), links + 1);
      }
      const parent = path.dirname(current);
      if (parent === current) throw new Error('Cannot resolve the export output directory.');
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function validateOutput(watchdog) {
  const output = watchdog.settings.output ? await canonicalOutput(watchdog.settings.output) : null;
  if (output && (normalized(output) === normalized(watchdog.folder) || watchdog.recursive && within(watchdog.folder, output))) {
    throw new Error('The export output directory must be outside the watched folder to avoid uploading exported copies repeatedly.');
  }
  return output;
}

function safeQuota(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['allowed', 'unavailable']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Number.isSafeInteger(value.proposedBytes) && value.proposedBytes >= 0) result.proposedBytes = value.proposedBytes;
  if (Array.isArray(value.reasons)) result.reasons = value.reasons.filter(item => typeof item === 'string').slice(0, 32)
    .map(item => item.replace(/[\r\n\0]/g, ' ').slice(0, 500));
  if (value.storage === null) result.storage = null;
  else if (value.storage && typeof value.storage === 'object' && !Array.isArray(value.storage)) {
    const storage = {};
    for (const key of ['quotaBytes', 'usedBytes', 'remainingBytes', 'dailyVideoLimit', 'dailyVideoBytes', 'dailyRemainingBytes']) {
      if (Number.isSafeInteger(value.storage[key]) && value.storage[key] >= 0) storage[key] = value.storage[key];
    }
    for (const key of ['tier', 'label', 'fetchedAt']) if (typeof value.storage[key] === 'string') storage[key] = value.storage[key].replace(/[\r\n\0]/g, ' ').slice(0, 100);
    if (typeof value.storage.overQuota === 'boolean') storage.overQuota = value.storage.overQuota;
    if (value.storage.source === 'https://smolish.com/storage/apply') storage.source = value.storage.source;
    result.storage = storage;
  }
  return Object.keys(result).length ? result : null;
}

async function verifySource(watchdog, candidate) {
  const root = await rootFolder(watchdog.folder);
  if (normalized(root) !== normalized(watchdog.folder)) throw new Error('The watchdog folder changed. Stop and add it again.');
  if (!within(root, candidate.file)) throw new Error('The file is outside the watchdog folder.');
  const stat = await lstat(candidate.file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Watchdogs upload regular files without symbolic links.');
  const actual = await realpath(candidate.file);
  if (!within(root, actual) || normalized(actual) !== normalized(candidate.file)) throw new Error('The file moved outside the watchdog folder.');
  if (candidate.fingerprint && statFingerprint(stat) !== candidate.fingerprint) throw new Error('The watched video changed while it was being prepared.');
  return stat;
}

async function scanFolder(watchdog) {
  const root = await rootFolder(watchdog.folder);
  if (normalized(root) !== normalized(watchdog.folder)) throw new Error('The watchdog folder changed. Stop and add it again.');
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (watchdog.recursive && within(root, await realpath(file))) await visit(file);
      } else if (stat.isFile() && stat.size > 0 && EXTENSIONS.has(path.extname(file).toLowerCase())) {
        const candidate = { file, relative: path.relative(root, file), sizeBytes: stat.size,
          key: fileKey(file), identity: statIdentity(file, stat), fingerprint: statFingerprint(stat) };
        await verifySource(watchdog, candidate);
        files.push(candidate);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
}

async function contentHash(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

function recordSummary(record) {
  return { file: record.file, relative: record.relative, status: record.status, global: record.global ?? null,
    index: record.index ?? null, parts: record.partsReserved ?? null, jobIds: record.jobIds || [], videoIds: record.videoIds || [],
    createdAt: record.createdAt || null, completedAt: record.completedAt || null, error: record.error || null,
    uncertain: record.uncertain || false, ...(record.quota ? { quota: record.quota } : {}) };
}

function journalSummary(journal = emptyJournal()) {
  const records = Object.values(journal.records);
  return { uploadedClips: records.filter(record => record.status === 'done').reduce((sum, record) => sum + (record.partsReserved || 1), 0),
    reservedClips: journal.count, blockedFiles: records.filter(record => record.status === 'blocked').length,
    pendingFiles: records.filter(record => record.status === 'retry').length, ignoredFiles: Object.keys(journal.ignored).length };
}

function selectedNames(registry, target) {
  if (!target || target === 'all') return Object.keys(registry.watchdogs).sort();
  watchdogName(target);
  if (!Object.hasOwn(registry.watchdogs, target)) throw new Error(`Watchdog "${target}" does not exist.`);
  return [target];
}

export async function createWatchdogSession(target = 'all', options = {}) {
  if (typeof options.uploadFile !== 'function') throw new Error('A watchdog upload handler is required.');
  const paths = watchdogPaths(options);
  const registry = checkRegistry(await readJson(paths.config, emptyRegistry));
  const names = selectedNames(registry, target);
  if (!names.length) throw new Error('No watchdogs are configured. Use smup watchdog add <name> <folder>.');
  const lock = await acquireFileLock(paths.runner, { names, startedAt: new Date().toISOString() }, { signal: options.signal });
  const session = { paths, lock, names: new Set(names), registry, signal: options.signal, uploadFile: options.uploadFile,
    emit: options.emit || (() => {}), now: options.now || Date.now, options, closed: false };
  try {
    await transaction(paths, state => {
      for (const name of names) {
        const journal = state.watchdogs[name] ||= emptyJournal();
        for (const record of Object.values(journal.records)) {
          if (record.status === 'uploading') {
            record.status = 'blocked'; record.uncertain = true;
            record.error = 'The previous runner ended during an upload. Retry explicitly to resume the saved job IDs.';
          }
        }
      }
    });
    for (const name of names) await session.emit({ type: 'watchdog_started', name, folder: registry.watchdogs[name].folder, pid: process.pid });
    return session;
  } catch (error) { await lock.release(); throw error; }
}

export async function closeWatchdogSession(session) {
  if (session.closed) return;
  session.closed = true;
  await session.lock.release();
  for (const name of session.names) await session.emit({ type: 'watchdog_stopped', name });
  session.names.clear();
}

async function stopped(session, name) {
  const file = path.join(session.paths.stateDir, `stop-${name}.json`);
  const request = await readJson(file, () => null);
  return request?.token === session.lock.token;
}

async function checkStopRequests(session) {
  let changed = false;
  for (const name of [...session.names]) {
    if (session.signal?.aborted || await stopped(session, name)) {
      session.names.delete(name); changed = true;
      await session.emit({ type: 'watchdog_stopped', name });
    }
  }
  if (changed) {
    const current = await readJson(session.paths.runner, () => null);
    if (current?.token !== session.lock.token) throw new Error('The watchdog runner lock changed.');
    const names = [...session.names];
    await writeJson(session.paths.runner, { pid: session.lock.pid, token: session.lock.token, names, startedAt: session.lock.startedAt });
    session.lock.names = names;
  }
}

async function uploadCandidate(session, name, watchdog, candidate, hash) {
  const id = digest(`${candidate.key}\0${hash}`);
  const started = await transaction(session.paths, state => {
    const journal = state.watchdogs[name];
    const previous = journal.records[id];
    if (previous && previous.status !== 'retry') return null;
    const record = previous || { file: candidate.file, relative: candidate.relative, sha256: hash,
      fingerprint: candidate.fingerprint,
      global: ++state.globalCount, index: ++journal.count, partsReserved: 1, jobIds: [], videoIds: [],
      createdAt: new Date(session.now()).toISOString() };
    record.status = 'uploading'; record.error = null; delete record.quota;
    journal.records[id] = record;
    return structuredClone(record);
  }, { signal: session.signal });
  if (!started) return false;
  const updateRecord = callback => transaction(session.paths, state => {
    const journal = state.watchdogs[name], record = journal.records[id];
    if (!record || record.status !== 'uploading') throw new Error('The watchdog upload journal changed during an upload.');
    return callback(record, journal, state);
  });
  const context = { watchdog: name, folder: watchdog.folder, filename: path.parse(candidate.file).name,
    sourceFilename: path.basename(candidate.file), global: started.global, index: started.index,
    settings: structuredClone(watchdog.settings), existingJobIds: [...(started.jobIds || [])],
    uncertain: Boolean(started.uncertain), signal: session.signal,
    shouldStop: () => stopped(session, name),
    validateSource: () => verifySource(watchdog, candidate),
    async reserveParts(count) {
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('The number of watchdog upload parts must be a positive integer.');
      return updateRecord((record, journal, state) => {
        if (record.partsReserved !== 1 && record.partsReserved !== count) throw new Error('The resumed part count differs from the saved watchdog upload.');
        if (record.partsReserved === 1 && count > 1) {
          if (state.globalCount !== record.global || journal.count !== record.index) {
            // A failed pre-probe attempt may be retried after later files were uploaded.
            // Reserve a new contiguous range; the old slot is never reused.
            record.global = state.globalCount + 1; record.index = journal.count + 1;
            state.globalCount += count; journal.count += count;
          } else { state.globalCount += count - 1; journal.count += count - 1; }
          record.partsReserved = count;
        }
        context.global = record.global; context.index = record.index;
        return { global: record.global, index: record.index, parts: record.partsReserved };
      });
    },
    async recordCheckpoint(checkpoint = {}) {
      return updateRecord(record => {
        for (const field of ['jobIds', 'videoIds']) if (checkpoint[field] !== undefined) {
          if (!Array.isArray(checkpoint[field]) || !checkpoint[field].every(value => typeof value === 'string' && value.length <= 100)) {
            throw new Error(`Watchdog ${field} must be an array of IDs.`);
          }
          record[field] = [...new Set([...(record[field] || []), ...checkpoint[field]])];
        }
      });
    },
  };
  await session.emit({ type: 'upload_started', name, file: candidate.file, global: started.global, index: started.index, jobIds: context.existingJobIds });
  try {
    session.signal?.throwIfAborted();
    await validateOutput(watchdog);
    if (!context.existingJobIds.length) await context.validateSource();
    const result = await session.uploadFile(candidate.file, context);
    if (!result || !['uploaded', 'completed', 'done'].includes(result.status)) throw new Error(`Upload stopped with status "${result?.status || 'unknown'}".`);
    await context.recordCheckpoint({ jobIds: result.jobIds || (result.jobId ? [result.jobId] : []),
      videoIds: result.videoIds || (result.videoId ? [result.videoId] : []) });
    const record = await updateRecord(record => {
      record.status = 'done'; record.uncertain = false; record.error = null;
      record.completedAt = new Date(session.now()).toISOString();
      return recordSummary(record);
    });
    await session.emit({ type: 'upload_completed', name, ...record });
  } catch (error) {
    const record = await updateRecord(record => {
      const deferred = error?.code === 'WATCHDOG_STOP_REQUESTED' && !record.jobIds?.length;
      record.status = deferred ? 'retry' : 'blocked'; record.error = details(error);
      record.uncertain = deferred ? false : Boolean(record.jobIds?.length || session.signal?.aborted || error?.uncertain || record.uncertain);
      const quota = safeQuota(error?.quota);
      if (quota) record.quota = quota;
      return recordSummary(record);
    });
    await session.emit({ type: record.status === 'retry' ? 'upload_deferred' : 'upload_blocked', name, ...record });
  }
  return true;
}

export async function scanWatchdogSession(session) {
  if (session.closed) throw new Error('The watchdog session is closed.');
  let uploaded = 0;
  await checkStopRequests(session);
  for (const name of [...session.names]) {
    await checkStopRequests(session);
    if (!session.names.has(name)) continue;
    const watchdog = session.registry.watchdogs[name];
    const state = checkState(await readJson(session.paths.state, emptyState));
    const retries = Object.values(state.watchdogs[name]?.records || {}).filter(record => record.status === 'retry' && record.jobIds?.length);
    for (const record of retries) {
      if (session.signal?.aborted || await stopped(session, name)) break;
      // Saved jobs already own their prepared bytes. Resume them without reading a
      // source that may have been removed or replaced since the original upload.
      const candidate = { file: record.file, relative: record.relative, key: fileKey(record.file), fingerprint: record.fingerprint };
      if (!within(watchdog.folder, candidate.file)) throw new Error('The saved retry file is outside the watchdog folder.');
      if (await uploadCandidate(session, name, watchdog, candidate, record.sha256)) uploaded++;
    }
    let candidates;
    try { candidates = await scanFolder(watchdog); }
    catch (error) { await session.emit({ type: 'watchdog_error', name, error: details(error) }); continue; }
    const stableMs = (session.options.stable === undefined ? watchdog.stable : seconds(session.options.stable, 'Stable delay', 0, 3600)) * 1000;
    const ready = await transaction(session.paths, state => {
      const journal = state.watchdogs[name];
      const present = new Set(candidates.map(candidate => candidate.key));
      for (const key of Object.keys(journal.seen)) if (!present.has(key)) delete journal.seen[key];
      const ready = [];
      for (const candidate of candidates) {
        const ignored = journal.ignored[candidate.key];
        if (ignored && (typeof ignored === 'string' ? ignored === candidate.identity
          : ignored.identity === candidate.identity && ignored.fingerprint === candidate.fingerprint)) continue;
        if (ignored) delete journal.ignored[candidate.key];
        const previous = journal.seen[candidate.key];
        if (!previous || previous.fingerprint !== candidate.fingerprint) {
          journal.seen[candidate.key] = { fingerprint: candidate.fingerprint, stableSince: session.now() };
        }
        const known = journal.records[journal.seen[candidate.key].recordId];
        if (known && known.status !== 'retry') continue;
        if (session.now() - journal.seen[candidate.key].stableSince >= stableMs) ready.push(candidate);
      }
      return ready;
    });
    for (const candidate of ready) {
      if (session.signal?.aborted || await stopped(session, name)) break;
      try {
        await verifySource(watchdog, candidate);
        const hash = await contentHash(candidate.file, session.signal);
        await verifySource(watchdog, candidate);
        if (await uploadCandidate(session, name, watchdog, candidate, hash)) uploaded++;
        await transaction(session.paths, state => {
          const observation = state.watchdogs[name].seen[candidate.key];
          if (observation?.fingerprint === candidate.fingerprint) observation.recordId = digest(`${candidate.key}\0${hash}`);
        });
      } catch (error) {
        await session.emit({ type: 'file_waiting', name, file: candidate.file, error: details(error) });
      }
    }
  }
  await checkStopRequests(session);
  return { active: session.names.size, attempted: uploaded };
}

async function runnerStatus(paths) {
  const lock = await readLock(paths.runner);
  return lock ? { pid: lock.pid, names: lock.names || [], startedAt: lock.startedAt || null, token: lock.token } : null;
}

async function runWatchdogs(target, options) {
  const session = await createWatchdogSession(target, options);
  const startedNames = [...session.names];
  try {
    while (!session.signal?.aborted && session.names.size) {
      await scanWatchdogSession(session);
      if (session.signal?.aborted || !session.names.size) break;
      const intervals = [...session.names].map(name => session.registry.watchdogs[name].interval);
      const secondsValue = options.interval === undefined ? Math.min(...intervals) : seconds(options.interval, 'Interval', 0.1, 3600);
      const deadline = Date.now() + secondsValue * 1000;
      while (Date.now() < deadline && session.names.size && !session.signal?.aborted) {
        try { await delay(Math.min(1000, deadline - Date.now()), undefined, { signal: session.signal }); }
        catch (error) { if (!session.signal?.aborted) throw error; }
        await checkStopRequests(session);
      }
    }
    return { status: 'stopped', names: startedNames };
  } finally { await closeWatchdogSession(session); }
}

export async function watchdogCommand(args = [], options = {}) {
  const [action = 'list', target, folder, ...extra] = args;
  const paths = watchdogPaths(options);
  if (extra.length) throw new Error('Use smup watchdog add <name> <folder> or watchdog list|show|remove|start|stop|status|retry.');
  if (action === 'add') {
    watchdogName(target);
    if (!folder) throw new Error('Usage: smup watchdog add <name> <folder>');
    const record = { folder: await rootFolder(folder), settings: snapshotSettings(options.resolvedSettings || options.settings || DEFAULTS),
      recursive: Boolean(options.recursive), existing: Boolean(options.existing),
      interval: seconds(options.interval ?? 5, 'Interval', 0.1, 3600), stable: seconds(options.stable ?? 10, 'Stable delay', 0, 3600),
      createdAt: new Date().toISOString() };
    const output = await validateOutput(record);
    if (output) record.settings.output = output;
    const candidates = record.existing ? [] : await scanFolder(record);
    await transaction(paths, async registry => {
      if (Object.hasOwn(registry.watchdogs, target)) throw new Error(`Watchdog "${target}" already exists.`);
      for (const existing of Object.values(registry.watchdogs)) {
        if (normalized(existing.folder) === normalized(record.folder) || existing.recursive && within(existing.folder, record.folder)
            || record.recursive && within(record.folder, existing.folder)) throw new Error('Watchdog folders must not overlap. Use one recursive watchdog for that folder.');
      }
      const state = checkState(await readJson(paths.state, emptyState));
      const journal = state.watchdogs[target] ||= emptyJournal();
      for (const candidate of candidates) journal.ignored[candidate.key] = { identity: candidate.identity, fingerprint: candidate.fingerprint };
      await writeJson(paths.state, state);
      registry.watchdogs[target] = record;
    }, { registry: true });
    return { status: 'added', name: target, ...record, ignoredFiles: candidates.length };
  }
  if (action === 'start') {
    if (folder) throw new Error('Usage: smup watchdog start [name|all]');
    return runWatchdogs(target || 'all', options);
  }
  const registry = checkRegistry(await readJson(paths.config, emptyRegistry));
  const state = checkState(await readJson(paths.state, emptyState));
  const runner = await runnerStatus(paths);
  if (['list', 'status'].includes(action)) {
    if (folder || (action === 'list' && target)) throw new Error(`Usage: smup watchdog ${action}${action === 'status' ? ' [name|all]' : ''}`);
    const names = action === 'status' ? selectedNames(registry, target) : Object.keys(registry.watchdogs).sort();
    return { status: 'ok', globalReservedClips: state.globalCount, watchdogs: names.map(name => ({ name, ...registry.watchdogs[name],
      running: Boolean(runner?.names.includes(name)), pid: runner?.names.includes(name) ? runner.pid : null,
      ...journalSummary(state.watchdogs[name]) })) };
  }
  if (action === 'stop') {
    if (folder) throw new Error('Usage: smup watchdog stop [name|all]');
    const names = selectedNames(registry, target);
    const running = names.filter(name => runner?.names.includes(name));
    for (const name of running) await writeJson(path.join(paths.stateDir, `stop-${name}.json`), { token: runner.token, requestedAt: new Date().toISOString() });
    return { status: running.length ? 'stop-requested' : 'not-running', names: running };
  }
  if (['show', 'remove', 'rm', 'retry'].includes(action)) {
    watchdogName(target);
    if (!Object.hasOwn(registry.watchdogs, target)) throw new Error(`Watchdog "${target}" does not exist.`);
    if (action !== 'retry' && folder) throw new Error(`Usage: smup watchdog ${action} <name>`);
    if (action === 'show') return { status: 'ok', name: target, ...registry.watchdogs[target],
      running: Boolean(runner?.names.includes(target)), ...journalSummary(state.watchdogs[target]),
      records: Object.values(state.watchdogs[target]?.records || {}).map(recordSummary) };
    if (action === 'retry') {
      const requested = folder ? path.resolve(folder) : null;
      if (requested && !within(registry.watchdogs[target].folder, requested)) throw new Error('The retry file must be inside the watchdog folder.');
      const retried = await transaction(paths, value => {
        const journal = value.watchdogs[target] || emptyJournal();
        const records = Object.values(journal.records).filter(record => record.status === 'blocked' && (!requested || normalized(record.file) === normalized(requested)));
        for (const record of records) record.status = 'retry';
        return records.map(recordSummary);
      });
      if (!retried.length) throw new Error('No blocked watchdog uploads match. Use smup watchdog show <name>.');
      return { status: 'retry-requested', name: target, records: retried };
    }
    if (runner?.names.includes(target)) throw new Error('Stop this watchdog before removing it.');
    await transaction(paths, async value => {
      if ((await runnerStatus(paths))?.names.includes(target)) throw new Error('Stop this watchdog before removing it.');
      delete value.watchdogs[target];
    }, { registry: true });
    // Keep upload history and counters so adding the same folder again cannot silently duplicate completed uploads.
    return { status: 'removed', name: target, historyRetained: true };
  }
  throw new Error('Use smup watchdog add|list|show|remove|start|stop|status|retry.');
}
