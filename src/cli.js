import path from 'node:path';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectBackend } from 'veodl/src/backend.js';
import { loadAuth, setupAuth } from './auth.js';
import { SmolishApi, videoId, videoSummary } from './api.js';
import { loadJob, listJobs, acquireLock } from './jobs.js';
import { authFile } from './paths.js';
import { parseArgs } from './arguments.js';
import { HELP, COMMAND_HELP } from './help.js';
import { loadConfig, emptyConfig, configCommand, presetCommand, resolveSettings } from './config.js';
import { metadataOverrides, DEFAULTS } from './settings.js';
import { createTerminal } from './terminal.js';
import { aliasCommand } from './aliases.js';
import { listAccountVideos } from './catalog.js';
import { prepareUploadJobs, loadUploadJobs } from './split.js';
import { preparedResult, overrideJobMetadata, publishUploadJobs } from './upload-flow.js';
import { readStorage, evaluateQuota, REFERENCE_TIERS, formatSize, askYesNo } from './storage.js';
import { watchdogCommand, reserveGlobalUploads } from './watchdog.js';
import { VERSION, COMMAND } from './identity.js';
import { checkVersion, updatePackage, repairTools } from './maintenance.js';

export { parseArgs } from './arguments.js';
const dash = value => value ?? '—';
const visibleTitle = value => value?.trim() ? value : '(blank)';

async function acquireWatchdogLock(signal, context) {
  while (true) {
    signal.throwIfAborted();
    if (await context.shouldStop?.()) {
      const error = new Error('Watchdog stop requested before uploading.');
      error.code = 'WATCHDOG_STOP_REQUESTED'; throw error;
    }
    try { return await acquireLock(); }
    catch (error) {
      if (error.code !== 'UPLOAD_BUSY') throw error;
      await delay(1000, undefined, { signal });
    }
  }
}

function render(terminal, command, data) {
  if (command === 'list') {
    terminal.table(['ID', 'Visibility', 'Status', 'Views', 'Likes', 'Comments', 'Title'],
      data.items.map(v => [v.id, dash(v.visibility), dash(v.status), dash(v.views), dash(v.likes), dash(v.comments), visibleTitle(v.title)]));
    terminal.output(`${data.count} video(s)${data.total !== null ? ` of ${data.total}` : ''}; ${data.pagesFetched} page(s).`);
  } else if (command === 'info' || command === 'edit') {
    terminal.label('Video', data.video.id, 'title');
    terminal.label('Title', visibleTitle(data.video.title), 'title');
    terminal.label('Visibility', dash(data.video.visibility));
    terminal.label('Status', dash(data.video.status));
    terminal.label('Views', dash(data.video.views));
    terminal.label('Likes', dash(data.video.likes));
    terminal.label('Comments', dash(data.video.comments));
    terminal.label('Description', data.video.description);
    terminal.output(data.video.url, 'success');
  } else if (command === 'jobs' && data.jobs) {
    terminal.table(['Job ID', 'Stage', 'Visibility', 'Video ID', 'Created'],
      data.jobs.map(j => [j.id, j.stage, j.visibility, j.videoId || '—', j.createdAt]));
    terminal.output(`${data.jobs.length} job(s) of ${data.total}${data.skipped ? `; ${data.skipped} damaged record(s) skipped` : ''}.`);
  } else if (command === 'alias' && data.aliases) {
    terminal.label('Command directory', data.binDir);
    terminal.table(['Command', 'Type', 'Installed'], data.aliases.map(a => [a.name, a.builtin ? 'built-in' : 'custom', a.present ? 'yes' : 'no']));
  } else if (command === 'alias') {
    terminal.output(`Alias ${data.name} ${data.status}.`, 'success');
    terminal.label('Command directory', data.binDir);
  } else if (command === 'config') {
    terminal.label('Config', data.file);
    if (data.config) terminal.output(`Configuration ${data.status === 'ok' ? 'loaded' : data.status}.`, 'success');
    if (data.effective) {
      terminal.label('Active preset', data.effective.preset || '(none)', 'title');
      terminal.table(['Setting', 'Effective value'], Object.entries(data.effective).filter(([key]) => key !== 'preset')
        .map(([key, value]) => [key, key === 'rename' ? visibleTitle(value) : String(value)]));
    }
  } else if (command === 'preset') {
    if (data.name) terminal.output(`Preset ${data.name}${data.status === 'ok' ? '' : ` ${data.status}`}.`, data.status === 'ok' ? 'title' : 'success');
    if (data.effective) terminal.table(['Setting', 'Effective value'], Object.entries(data.effective).filter(([key]) => key !== 'preset')
      .map(([key, value]) => [key, key === 'rename' ? visibleTitle(value) : String(value)]));
    if (data.presets) {
      terminal.label('Active preset', data.activePreset || '(none)', 'title');
      terminal.table(['Preset', 'Visibility', 'Duration', 'Quality', 'Title'], Object.entries(data.presets)
        .map(([name, settings]) => [name, settings.visibility || '(inherit)', settings.duration ?? '(inherit)', settings.quality || '(inherit)',
          settings.rename === undefined ? '(inherit)' : visibleTitle(settings.rename)]));
      if (!Object.keys(data.presets).length) terminal.output('No presets configured.');
    }
  } else if (command === 'analytics') {
    terminal.output(`${data.videoId ? `Video ${data.videoId}` : 'Account'} analytics (${data.days} days)`, 'title');
    terminal.object(data.analytics);
  } else if (command === 'jobs' && data.job) {
    const saved = data.job;
    terminal.label('Job', saved.id, 'title');
    terminal.label('Stage', saved.stage);
    terminal.label('Source', saved.source);
    terminal.label('Title', visibleTitle(saved.metadata.title), 'title');
    terminal.label('Visibility', saved.metadata.visibility);
    if (saved.videoId) terminal.label('Video ID', saved.videoId);
    if (saved.prepared) terminal.label('Prepared file', saved.prepared);
    if (saved.output) terminal.label('Saved copy', saved.output);
  } else if (command === 'whoami' || command === 'setup') {
    terminal.output(`Signed in${data.user.name ? ` as ${data.user.name}` : ''}.`, 'success');
    terminal.label('Account ID', data.user.id);
    if (data.authFile) terminal.label('Cookie file', data.authFile);
  } else if ((command === 'upload' || command === 'resume') && data.items) {
    terminal.output(`${data.partCount} clips ${data.status === 'prepared' ? 'prepared' : 'uploaded'}.`, 'success');
    terminal.label('Batch job', data.jobId);
    terminal.table(['Part', 'Visibility', 'Title', data.status === 'prepared' ? 'Prepared file' : 'Video'], data.items.map((item, i) =>
      [i + 1, item.visibility ?? item.metadata?.visibility, visibleTitle(item.title ?? item.metadata?.title), item.url || item.file]));
    if (data.status === 'prepared') terminal.output(`Upload all clips: smop resume ${data.jobId}`);
  } else if (command === 'upload' || command === 'resume') {
    terminal.output(data.status === 'prepared' ? 'Video prepared.' : 'Video uploaded.', 'success');
    terminal.label('Job', data.jobId);
    terminal.label('Visibility', data.visibility ?? data.metadata?.visibility);
    terminal.label('Title', visibleTitle(data.title ?? data.metadata?.title), 'title');
    if (data.file) terminal.label('Prepared file', data.file);
    if (data.output) terminal.label('Saved copy', data.output);
    if (data.url) terminal.output(data.url, 'success');
    if (data.status === 'prepared') terminal.output(`Upload: smop resume ${data.jobId}`);
  } else if (command === 'storage') {
    terminal.label('Tier', data.storage.label, 'title');
    terminal.label('Storage', `${formatSize(data.storage.usedBytes)} / ${formatSize(data.storage.quotaBytes)}`);
    terminal.label('Available storage', formatSize(data.storage.remainingBytes), 'success');
    terminal.label('Daily uploads', `${formatSize(data.storage.dailyVideoBytes)} / ${formatSize(data.storage.dailyVideoLimit)}`);
    terminal.label('Available today', formatSize(data.storage.dailyRemainingBytes), 'success');
    if (data.quota) {
      terminal.output(data.quota.allowed ? 'Upload fits the reported limits.' : 'Upload would exceed the reported limits.', data.quota.allowed ? 'success' : 'error');
      for (const reason of data.quota.reasons) terminal.output(reason, 'error');
    }
    terminal.output('Reference tiers observed October 1, 2026:', 'title');
    terminal.table(['Tier', 'Storage', 'Per day'], data.tiers.map(t => [t.label, formatSize(t.quotaBytes), formatSize(t.dailyVideoLimit)]));
  } else if (command === 'watchdog' && data.watchdogs) {
    terminal.table(['Watchdog', 'Running', 'Uploaded', 'Blocked', 'Folder'], data.watchdogs.map(w =>
      [w.name, w.running ? 'yes' : 'no', w.uploadedClips ?? 0, w.blockedFiles ?? 0, w.folder]));
    if (!data.watchdogs.length) terminal.output('No watchdogs configured.');
  } else if (command === 'watchdog') {
    terminal.output(`Watchdog ${data.name || data.names?.join(', ') || ''} ${data.status}.`, 'success');
    if (data.folder) terminal.label('Folder', data.folder);
    if (data.settings) terminal.label('Title template', visibleTitle(data.settings.rename), 'title');
    if (data.records) terminal.object(data.records);
  } else if (command === 'version' || command === 'update') {
    terminal.label('Package', data.package, 'title');
    terminal.label('Installed', data.installed);
    terminal.label('Latest', data.latest || '(not published)', data.updateAvailable ? 'title' : 'success');
    const messages = { current: 'The installed version is up to date.', ahead: 'The installed version is newer than the npm release.',
      'update-available': `An update is available. Run ${COMMAND} update.`, updated: 'Update installed. Run the command again to use the new version.' };
    terminal.output(data.message || messages[data.status] || data.status, 'success');
    if (data.installCommand) terminal.label('Install command', data.installCommand, 'title');
  } else if (command === 'doctor' || command === 'doctorfix') {
    terminal.table(['Check', 'Status', 'Details'], data.checks.map(c => [c.name, c.status, c.detail]));
    terminal.output(command === 'doctorfix'
      ? data.ready ? 'Media tools are ready.' : 'Media tools repaired; sign-in needs attention.'
      : data.ready ? 'Setup is ready.' : 'Setup needs attention.', data.ready ? 'success' : 'error');
  } else terminal.object(data);
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Cancelled.'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let job, unlock, options, terminal;
  try {
    options = args.length ? parseArgs(args) : { command: 'help', args: [], overrides: {} };
    if (options.version || options.help || options.command === 'help') {
      const helpTarget = options.command === 'help' ? options.args[0]
        : options.command === 'upload' && !options.args.length && !args.includes('upload') ? null : options.command;
      const value = options.version ? `${COMMAND} ${VERSION}` : (COMMAND_HELP[helpTarget] || HELP);
      const helpConfig = await loadConfig().catch(() => emptyConfig());
      terminal = createTerminal({ json: options.json, color: options.overrides.color ?? helpConfig.defaults.color ?? DEFAULTS.color,
        forceColor: options.overrides.color === true, stdout, stderr });
      if (options.json) terminal.json({ command: options.version ? 'version' : 'help', status: 'ok', [options.version ? 'version' : 'text']: options.version ? VERSION : value });
      else if (options.version) terminal.output(value, 'heading');
      else terminal.help(value);
      return 0;
    }
    // Local recovery commands remain usable when a manually edited config is invalid.
    let config;
    try { config = await loadConfig(); }
    catch (error) {
      if (options.command === 'upload' || (['resume', 'edit'].includes(options.command) && options.preset && options.preset !== 'none')) throw error;
      config = emptyConfig();
    }
    const uploadSettings = options.command === 'upload' ? resolveSettings(config, options.overrides, options.preset) : null;
    const color = options.overrides.color ?? uploadSettings?.color ?? config?.defaults.color ?? DEFAULTS.color;
    terminal = createTerminal({ json: options.json, color, forceColor: options.overrides.color === true, stdout, stderr });
    const result = data => {
      if (options.json) terminal.json({ command: options.command, ...data });
      else render(terminal, options.command, data);
    };
    const step = (label, fn) => terminal.step(label, fn);
    const signal = controller.signal;
    const authenticate = async () => {
      const api = dependencies.api || new SmolishApi({ ...await loadAuth(), signal });
      const user = await step('Checking Smolish session', () => api.checkAuth());
      return { api, user };
    };
    if (options.command === 'version') {
      result(await step('Checking npm release', () => (dependencies.checkVersion || checkVersion)({ signal }))); return 0;
    }
    if (options.command === 'update') {
      result(await step(options.check ? 'Checking npm release' : 'Checking and installing npm update',
        () => (dependencies.updatePackage || updatePackage)({ signal, checkOnly: options.check }))); return 0;
    }
    if (options.command === 'doctorfix') {
      const repaired = await step('Repairing VEO media tools', () => (dependencies.repairTools || repairTools)({ signal, onStatus: message => terminal.say(message) }));
      if (options.online) {
        try {
          const { user } = await authenticate();
          repaired.checks.push({ name: 'Session', status: 'ok', detail: `Account ${user.id}` });
        } catch (error) {
          signal.throwIfAborted();
          repaired.ready = false;
          repaired.status = 'attention';
          repaired.checks.push({ name: 'Session', status: 'failed', detail: error.message });
        }
      }
      result(repaired); return repaired.ready ? 0 : 1;
    }
    if (options.command === 'config') {
      if (options.json && options.args[0] === 'edit') throw new Error('Config edit requires an interactive editor. Use config set with --json.');
      result(await configCommand(options.args, { preset: options.preset })); return 0;
    }
    if (options.command === 'preset') {
      result(await presetCommand(options.args, options.overrides)); return 0;
    }
    if (options.command === 'alias') {
      result(await aliasCommand(options.args, { binDir: options.binDir })); return 0;
    }
    if (options.command === 'jobs') {
      if (options.args[0]) {
        const saved = await loadJob(options.args[0]);
        result({ status: 'ok', job: { id: saved.id, source: saved.source, stage: saved.stage, metadata: saved.metadata,
          settings: saved.settings || null, createdAt: saved.createdAt, completedAt: saved.completedAt || null,
          videoId: saved.videoId || null, durationSeconds: saved.durationSeconds ?? null, sizeBytes: saved.sizeBytes ?? null,
          prepared: saved.stage === 'done' || saved.kind === 'batch' ? null : saved.prepared, output: saved.output || null,
          kind: saved.kind || 'video', children: saved.children || [], partCount: saved.partCount || 1,
          parentId: saved.parentId || null, result: saved.result || null } });
      } else result({ status: 'ok', ...await listJobs(options.limit) });
      return 0;
    }
    if (options.command === 'watchdog') {
      const action = options.args[0] || 'list';
      const addSettings = action === 'add' ? resolveSettings(await loadConfig(), options.overrides, options.preset) : undefined;
      if (action === 'start') await authenticate();
      const watchResult = await watchdogCommand(options.args, {
        signal, resolvedSettings: addSettings,
        ...(action === 'add' ? { recursive: options.recursive, existing: options.existing, interval: options.interval, stable: options.stable } : {}),
        emit: event => {
          if (options.json) terminal.json({ command: 'watchdog', ...event });
          else terminal.say(`[${event.name || 'watchdog'}] ${event.type.replaceAll('_', ' ')}${event.file ? `: ${event.file}` : ''}${event.error ? ` — ${event.error}` : ''}`);
        },
        uploadFile: async (file, context) => {
          const release = await acquireWatchdogLock(signal, context);
          try {
            const { api: watchApi } = await authenticate();
            let parent, children;
            if (context.existingJobIds.length) {
              parent = await loadJob(context.existingJobIds.at(-1));
              if (parent.stage === 'preparing') {
                // Explicit retry may replace incomplete local preparation only after proving there are no remote drafts.
                for (const id of context.existingJobIds) {
                  const old = await loadJob(id);
                  const descendants = old.children ? await Promise.all(old.children.map(loadJob)) : [];
                  if ([old, ...descendants].some(j => j.videoId || ['creating', 'creation-uncertain'].includes(j.stage))) {
                    throw new Error('A previous attempt may have a remote draft. Resume its saved job before preparing another upload.');
                  }
                }
                parent = undefined;
              } else children = await loadUploadJobs(parent);
            }
            if (!parent) {
              await context.validateSource();
              const titles = { filename: context.filename, folder: path.basename(context.folder), global: context.global, index: context.index };
              const prepared = await (dependencies.prepareUploadJobs || prepareUploadJobs)(file, context.settings, {
                signal, step, log: text => terminal.say(text), context: titles,
                onJobCreated: async created => { await context.recordCheckpoint({ jobIds: [created.id] }); },
                onPlan: async count => { Object.assign(titles, await context.reserveParts(count)); },
              });
              parent = prepared.job; children = prepared.jobs;
            }
            const timing = { started: Date.now(), initial: 0, lastBytes: Infinity };
            const uploaded = await publishUploadJobs(watchApi, parent, children, {
              signal, step, log: text => terminal.say(text), tryAnyway: options.tryAnyway, interactive: false,
              progress: (bytes, total) => {
                if (bytes < timing.lastBytes) { timing.started = Date.now(); timing.initial = bytes; }
                timing.lastBytes = bytes; terminal.progress(bytes, total, timing);
              },
            });
            return { ...uploaded, jobIds: [parent.id], videoIds: uploaded.items ? uploaded.items.map(item => item.videoId) : [uploaded.videoId] };
          } finally { await release(); }
        },
      });
      result(watchResult);
      return signal.aborted ? 130 : 0;
    }
    if (options.command === 'doctor') {
      const checks = [];
      try { await loadConfig(); checks.push({ name: 'Config', status: 'ok', detail: 'Valid local settings' }); }
      catch (error) { checks.push({ name: 'Config', status: 'failed', detail: error.message }); }
      let credentials;
      try { credentials = await loadAuth(); checks.push({ name: 'Cookie', status: 'ok', detail: 'Available; use --online to verify sign-in' }); }
      catch (error) { checks.push({ name: 'Cookie', status: 'missing', detail: error.message }); }
      const backend = await step('Inspecting VEO tools', () => inspectBackend({ signal }));
      for (const name of ['ytDlp', 'ffmpeg', 'ffprobe']) {
        const damaged = name === 'ytDlp' && backend[name].present && ['managed', 'installed'].includes(backend[name].source) && !backend[name].verified;
        checks.push({ name, status: damaged ? 'failed' : backend[name].present ? 'ok' : 'pending',
          detail: damaged ? 'Cached tool failed verification. Run smop doctorfix.' : backend[name].path || 'Installed automatically on first use' });
      }
      for (const error of backend.errors) checks.push({ name: 'VEO', status: 'failed', detail: error });
      if (options.online && credentials) {
        try {
          const api = dependencies.api || new SmolishApi({ ...credentials, signal });
          const user = await step('Checking Smolish session', () => api.checkAuth());
          checks.push({ name: 'Session', status: 'ok', detail: `Account ${user.id}${user.name ? ` (${user.name})` : ''}` });
        } catch (error) { checks.push({ name: 'Session', status: 'failed', detail: error.message }); }
      }
      signal.throwIfAborted();
      const ready = !checks.some(c => ['failed', 'missing'].includes(c.status));
      result({ status: ready ? 'ok' : 'attention', ready, online: options.online, checks });
      return ready ? 0 : 1;
    }
    if (options.command === 'setup') {
      if (options.json) throw new Error('Cookie setup requires an interactive terminal. Use SMOP_COOKIE_FILE and whoami --json for automation.');
      await (dependencies.setupAuth || setupAuth)({ color, forceColor: options.overrides.color === true, signal,
        prompt: terminal.prompt('Smolish Cookie header (input hidden): ') });
      const { user } = await authenticate();
      result({ status: 'configured', user, authFile: authFile() }); return 0;
    }
    let api;
    if (!options.dryRun) {
      const authenticated = await authenticate();
      api = authenticated.api;
      if (options.command === 'whoami') { result({ status: 'authenticated', user: authenticated.user }); return 0; }
    }
    if (options.command === 'list') {
      result(await step('Loading account videos', () => listAccountVideos(api, options.filters, { all: options.all, signal }))); return 0;
    }
    if (options.command === 'info') {
      result({ status: 'ok', video: videoSummary(await step('Loading video', () => api.getVideo(videoId(options.source)))) }); return 0;
    }
    if (options.command === 'analytics') {
      const id = options.args[0] ? videoId(options.args[0]) : null;
      result({ status: 'ok', videoId: id, days: options.days,
        analytics: await step('Loading analytics', () => api.analytics(id, options.days)) }); return 0;
    }
    if (options.command === 'storage') {
      const storage = await step('Loading account storage', () => readStorage(api));
      let bytes = options.bytes;
      if (options.args[0]) {
        const info = await stat(path.resolve(options.args[0]));
        if (!info.isFile()) throw new Error('The storage check requires a regular file.');
        bytes = info.size;
      }
      const quota = bytes === undefined ? null : evaluateQuota(storage, bytes);
      result({ status: quota && !quota.allowed ? 'attention' : 'ok', storage, quota, tiers: REFERENCE_TIERS, tiersObservedAt: '2026-10-01' });
      return quota && !quota.allowed ? 1 : 0;
    }
    const selectedMetadata = () => {
      if (!options.preset || options.preset === 'none') return metadataOverrides(options.overrides);
      if (!Object.hasOwn(config.presets, options.preset)) throw new Error(`Unknown preset "${options.preset}". Run smop preset list.`);
      return metadataOverrides({ ...config.presets[options.preset], ...options.overrides });
    };
    if (options.command === 'edit') {
      const id = videoId(options.source), metadata = selectedMetadata();
      if (!Object.keys(metadata).length) throw new Error('The selected preset has no metadata. Supply --visibility, --rename or --description.');
      const video = await step('Saving video metadata', async () => {
        await api.metadata(id, metadata);
        const current = await api.getVideo(id);
        if (Object.entries(metadata).some(([key, value]) => current[key] !== value)) throw new Error('The requested metadata was not confirmed by Smolish.');
        return current;
      });
      result({ status: 'updated', video: videoSummary(video) }); return 0;
    }
    unlock = await acquireLock();
    let children;
    if (options.command === 'resume') {
      job = await loadJob(options.source);
      children = await loadUploadJobs(job);
      await overrideJobMetadata(job, children, selectedMetadata());
    } else {
      const context = { index: 1 };
      const prepared = await (dependencies.prepareUploadJobs || prepareUploadJobs)(options.source, uploadSettings, {
        signal, step, log: text => terminal.say(text), onDownloadLine: line => terminal.download(line), context,
        onJobCreated: created => { job = created; },
        onPlan: async count => { context.global = (await reserveGlobalUploads(count, { signal })).global; },
      });
      job = prepared.job; children = prepared.jobs;
      terminal.say(`Ready: ${children.length} clip(s), ${job.durationSeconds.toFixed(3)} seconds, ${formatSize(job.sizeBytes)}`);
      if (options.dryRun) {
        result(preparedResult(job, children)); return 0;
      }
    }
    const timing = { started: Date.now(), initial: 0, lastBytes: Infinity };
    const uploaded = await publishUploadJobs(api, job, children, { signal, step, log: text => terminal.say(text),
      tryAnyway: options.tryAnyway, interactive: !options.json && Boolean(process.stdin.isTTY),
      confirm: question => terminal.suspend(() => dependencies.confirm ? dependencies.confirm(question) : askYesNo(terminal.prompt(question), signal)),
      progress: (bytes, total) => {
        if (bytes < timing.lastBytes) { timing.started = Date.now(); timing.initial = bytes; }
        timing.lastBytes = bytes; terminal.progress(bytes, total, timing);
      } });
    result(uploaded);
    return 0;
  } catch (error) {
    const cancelled = controller.signal.aborted || error.name === 'AbortError';
    const message = cancelled ? 'Cancelled.' : error.message;
    terminal ||= createTerminal({ json: options?.json || args.includes('--json'), color: !args.includes('--no-color'), forceColor: args.includes('--color'), stdout, stderr });
    terminal.error(message);
    if (job?.videoId) terminal.say(`Resume: smop resume ${job.id}\nStudio: https://smolish.com/studio/video/${job.videoId}`);
    else if (['creation-uncertain', 'creating'].includes(job?.stage)) terminal.say('A draft may already exist. Check Smolish Studio before another upload.');
    else if (job?.stage === 'prepared' || job?.kind === 'batch' && job.stage !== 'preparing') terminal.say(`Resume: smop resume ${job.id}`);
    if (options?.json || args.includes('--json')) terminal.json({ command: options?.command || null, status: 'failed', error: message,
      jobId: job?.id || null, videoId: job?.videoId || null, ...(error.quota ? { quota: error.quota } : {}) });
    return cancelled ? 130 : 1;
  } finally {
    terminal?.close();
    await unlock?.();
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
