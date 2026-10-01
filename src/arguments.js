import { validateSetting, VISIBILITIES } from './settings.js';

const COMMANDS = ['upload', 'setup', 'whoami', 'resume', 'list', 'info', 'analytics', 'edit', 'config', 'preset', 'alias', 'jobs', 'doctor', 'doctorfix', 'version', 'update', 'storage', 'watchdog', 'help'];
const COMMAND_ALIASES = { history: 'jobs', presets: 'preset', aliases: 'alias', profile: 'preset', limits: 'storage', watch: 'watchdog' };
const STRINGS = new Set(['visibility', 'rename', 'title', 'description', 'start', 'duration', 'quality', 'output', 'preset', 'profile', 'limit', 'page', 'sort', 'order', 'status', 'days', 'bin-dir', 'split-threshold', 'part-label', 'interval', 'stable', 'name', 'bytes']);
const SHORT = { h: 'help', v: 'version', r: 'rename', d: 'description', o: 'output', p: 'preset', q: 'quality' };
const BOOLEAN = new Set(['help', 'version', 'json', 'dry-run', 'all', 'color', 'no-color', 'online', 'split', 'no-split', 'try-anyway', 'recursive', 'existing', 'check']);
const COMMON = ['help', 'version', 'json', 'color', 'no-color'];
const ALLOWED = {
  upload: [...STRINGS].filter(k => ['visibility', 'rename', 'title', 'description', 'start', 'duration', 'quality', 'output', 'preset', 'profile', 'split-threshold', 'part-label'].includes(k)).concat('dry-run', 'split', 'no-split', 'try-anyway'),
  resume: ['visibility', 'rename', 'title', 'description', 'preset', 'profile', 'try-anyway'],
  list: ['visibility', 'limit', 'page', 'sort', 'order', 'status', 'all'],
  analytics: ['days'], edit: ['visibility', 'rename', 'title', 'description', 'preset', 'profile'],
  config: ['preset', 'profile'], preset: ['visibility', 'rename', 'title', 'description', 'start', 'duration', 'quality', 'output', 'split', 'no-split', 'split-threshold', 'part-label'],
  storage: ['bytes'], watchdog: ['visibility', 'rename', 'title', 'description', 'start', 'duration', 'quality', 'output', 'preset', 'profile', 'split', 'no-split', 'split-threshold', 'part-label', 'recursive', 'existing', 'interval', 'stable', 'name', 'try-anyway'],
  alias: ['bin-dir'], jobs: ['limit'], doctor: ['online'], doctorfix: ['online'], version: [], update: ['check'], setup: [], whoami: [], info: [], help: [],
};

export function parseArgs(args) {
  const raw = {}, flags = [], positional = [];
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!item.startsWith('-')) { positional.push(item); continue; }
    const equal = item.indexOf('=');
    const flag = item.startsWith('--') ? item.slice(2, equal > 0 ? equal : undefined) : SHORT[item.slice(1)];
    if (!flag || (!STRINGS.has(flag) && !BOOLEAN.has(flag))) throw new Error(`Unknown option: ${item}. Run smup --help.`);
    flags.push(flag);
    if (BOOLEAN.has(flag)) {
      if (equal > 0) throw new Error(`--${flag} does not take a value.`);
      raw[flag] = true;
    } else {
      const value = equal > 0 ? item.slice(equal + 1) : args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${flag} requires a value.`);
      raw[flag] = value;
    }
  }
  let command = COMMAND_ALIASES[positional[0]] || positional[0];
  if (COMMANDS.includes(command)) positional.shift(); else command = 'upload';
  if (command === 'doctor' && positional[0] === 'fix') { command = 'doctorfix'; positional.shift(); }
  const options = { command, args: positional, json: Boolean(raw.json), help: Boolean(raw.help), version: Boolean(raw.version),
    dryRun: Boolean(raw['dry-run']), all: Boolean(raw.all), online: Boolean(raw.online), tryAnyway: Boolean(raw['try-anyway']),
    recursive: Boolean(raw.recursive), existing: Boolean(raw.existing), check: Boolean(raw.check), overrides: {}, filters: {} };
  if (raw.preset && raw.profile && raw.preset !== raw.profile) throw new Error('Use either --preset or --profile, not both.');
  options.preset = raw.preset || raw.profile;
  options.binDir = raw['bin-dir'];
  if (raw.color && raw['no-color']) throw new Error('Use either --color or --no-color.');
  if (raw.color || raw['no-color']) options.overrides.color = !raw['no-color'];
  if (options.help || options.version) return options;
  for (const flag of flags) if (!COMMON.includes(flag) && !ALLOWED[command].includes(flag)) throw new Error(`--${flag} is not supported by smup ${command}.`);
  if (raw.rename !== undefined && raw.title !== undefined) throw new Error('Use either --rename or --title, not both.');
  for (const key of ['visibility', 'rename', 'description', 'start', 'duration', 'quality', 'output']) {
    const value = key === 'rename' ? raw.rename ?? raw.title : raw[key];
    if (value !== undefined) options.overrides[key] = validateSetting(key, ['start', 'duration'].includes(key) ? (value.trim() ? Number(value) : NaN) : value);
  }
  if (raw.split && raw['no-split']) throw new Error('Use either --split or --no-split.');
  if (raw.split || raw['no-split']) options.overrides.split = !raw['no-split'];
  if (raw['split-threshold'] !== undefined) options.overrides.splitThreshold = validateSetting('splitThreshold', Number(raw['split-threshold']));
  if (raw['part-label'] !== undefined) options.overrides.partLabel = validateSetting('partLabel', raw['part-label']);
  const integer = (key, fallback, min, max) => {
    if (raw[key] === undefined) return fallback;
    const value = Number(raw[key]);
    if (!/^\d+$/.test(raw[key]) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  options.limit = integer('limit', command === 'jobs' ? 20 : 30, 1, command === 'jobs' ? 1000 : 50);
  options.page = integer('page', 1, 1, 100000);
  options.days = integer('days', 28, 1, 90);
  options.interval = integer('interval', 5, 1, 300);
  options.stable = integer('stable', 10, 1, 3600);
  options.name = raw.name;
  if (raw.bytes !== undefined) options.bytes = integer('bytes', undefined, 0, Number.MAX_SAFE_INTEGER);
  if (raw.days !== undefined && ![7, 28, 90].includes(options.days)) throw new Error('--days must be 7, 28 or 90.');
  options.filters = { page: options.page, limit: options.limit, sort: raw.sort || 'date', dir: raw.order || 'desc' };
  if (!['date', 'views', 'likes', 'comments'].includes(options.filters.sort)) throw new Error('--sort must be date, views, likes or comments.');
  if (!['asc', 'desc'].includes(options.filters.dir)) throw new Error('--order must be asc or desc.');
  if (raw.status) {
    if (!['draft', 'uploading', 'queued', 'processing', 'ready', 'failed'].includes(raw.status)) throw new Error('Invalid --status. Use draft, uploading, queued, processing, ready or failed.');
    options.filters.status = raw.status;
  }
  if (command === 'list') {
    if (positional.length > 1 || (positional[0] && !VISIBILITIES.includes(positional[0]))) throw new Error('Usage: smup list [private|public|unlisted]');
    if (positional[0] && raw.visibility && positional[0] !== raw.visibility) throw new Error('Conflicting visibility filters.');
    options.filters.visibility = positional[0] || raw.visibility;
    if (options.all && options.page !== 1) throw new Error('--all starts at page 1 and cannot be combined with another --page.');
  }
  if (['upload', 'resume', 'info', 'edit'].includes(command)) {
    if (positional.length !== 1) throw new Error(`smup ${command} requires exactly one ${command === 'upload' ? 'video URL or file' : command === 'resume' ? 'job ID' : 'video ID'}.`);
    options.source = positional[0];
  }
  if (['setup', 'whoami', 'doctor', 'doctorfix', 'version', 'update'].includes(command) && positional.length) throw new Error(`smup ${command} does not take positional arguments.`);
  if (['jobs', 'analytics'].includes(command) && positional.length > 1) throw new Error(`smup ${command} accepts at most one ID.`);
  if (command === 'storage' && (positional.length > 1 || (positional.length && options.bytes !== undefined))) throw new Error('Usage: smup storage [file] or smup storage --bytes <size>');
  if (command === 'watchdog') {
    const action = positional[0] || 'list';
    if (!['add', 'list', 'show', 'remove', 'rm', 'start', 'stop', 'status', 'retry'].includes(action)) throw new Error('Use smup watchdog add|list|show|remove|start|stop|status|retry.');
    if (action !== 'add' && flags.some(f => ['visibility', 'rename', 'title', 'description', 'start', 'duration', 'quality', 'output', 'preset', 'profile', 'split', 'no-split', 'split-threshold', 'part-label', 'recursive', 'existing', 'interval', 'stable', 'name'].includes(f))) throw new Error('Watchdog settings are only accepted by watchdog add.');
    if (options.tryAnyway && action !== 'start') throw new Error('--try-anyway applies only to watchdog start.');
    if (action === 'add' && positional.length === 2) {
      const folder = positional[1];
      const derived = folder.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
      options.args = ['add', options.name || derived, folder];
    } else if (action === 'add' && options.name) throw new Error('Use --name only with watchdog add <folder>.');
  }
  if (command === 'edit' && !Object.keys(options.overrides).some(k => ['visibility', 'rename', 'description'].includes(k)) && !options.preset) throw new Error('Use --visibility, --rename or --description to edit a video.');
  if (command === 'preset' && positional[0] !== 'add' && Object.keys(options.overrides).some(k => k !== 'color')) throw new Error('Preset settings are only accepted by smup preset add.');
  return options;
}
