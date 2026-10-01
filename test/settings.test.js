import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, metadataFromSettings, metadataOverrides } from '../src/settings.js';
import { configCommand, configFile, emptyConfig, loadConfig, presetCommand, resolveSettings, validateConfig } from '../src/config.js';
import { parseArgs } from '../src/arguments.js';
import { aliasCommand } from '../src/aliases.js';
import { createTerminal } from '../src/terminal.js';

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function temporaryConfig(t) {
  const directory = await temporaryDirectory(t, 'smup-config-test-');
  const previous = { SMUP_HOME: process.env.SMUP_HOME, SMUP_CONFIG: process.env.SMUP_CONFIG };
  process.env.SMUP_HOME = directory;
  delete process.env.SMUP_CONFIG;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  return directory;
}

function recordingStream(isTTY = false) {
  const chunks = [];
  return { isTTY, columns: 180, write(chunk) { chunks.push(String(chunk)); }, get text() { return chunks.join(''); } };
}

test('new uploads default to Private with exactly one space for their title and preserve the draft description', () => {
  assert.equal(DEFAULTS.visibility, 'private');
  assert.equal(DEFAULTS.rename, ' ');
  assert.deepEqual(metadataFromSettings(resolveSettings(emptyConfig())), { title: ' ', visibility: 'private' });
  assert.equal(Object.hasOwn(metadataFromSettings(DEFAULTS), 'description'), false);
  assert.deepEqual(metadataOverrides({ rename: 'Named clip' }), { title: 'Named clip' });
});

test('settings resolve from built-ins through config, active preset, then explicit CLI values', () => {
  const config = {
    version: 1, defaults: { visibility: 'unlisted', rename: 'Config title', duration: 45, color: false },
    presets: { share: { visibility: 'public', rename: 'Preset title', quality: '720p' }, quiet: { visibility: 'private' } },
    activePreset: 'share',
  };
  const effective = resolveSettings(config, { rename: 'CLI title', duration: 20 });
  assert.equal(effective.visibility, 'public');
  assert.equal(effective.rename, 'CLI title');
  assert.equal(effective.duration, 20);
  assert.equal(effective.quality, '720p');
  assert.equal(effective.color, false);
  assert.equal(effective.preset, 'share');
  assert.equal(resolveSettings(config, {}, 'quiet').visibility, 'private');
  assert.equal(resolveSettings(config, {}, 'none').visibility, 'unlisted');
  assert.equal(resolveSettings(config, {}, 'none').rename, 'Config title');
  assert.throws(() => resolveSettings(config, {}, 'missing'), /Unknown preset/);
  assert.throws(() => resolveSettings(config, { duration: 61 }), /at most 60/);
});

test('config and presets persist in the isolated local home and removal clears an active preset', async t => {
  const directory = await temporaryConfig(t);
  assert.equal(configFile(), path.join(directory, 'config.json'));
  assert.deepEqual(await loadConfig(), emptyConfig());
  await configCommand(['set', 'visibility', 'unlisted']);
  await configCommand(['set', 'duration', '30']);
  await configCommand(['set', 'color', 'false']);
  await presetCommand(['add', 'share'], { visibility: 'public', rename: ' ', quality: '720p' });
  await presetCommand(['use', 'share']);
  const persisted = await loadConfig();
  assert.deepEqual(persisted.defaults, { visibility: 'unlisted', duration: 30, color: false });
  assert.equal(persisted.activePreset, 'share');
  assert.equal(resolveSettings(persisted).visibility, 'public');
  await assert.rejects(presetCommand(['add', 'share'], { rename: 'Replacement' }), /already exists/);
  assert.equal((await loadConfig()).presets.share.rename, ' ');
  await presetCommand(['remove', 'share']);
  assert.equal((await loadConfig()).activePreset, null);
  await configCommand(['unset', 'visibility']);
  assert.equal(resolveSettings(await loadConfig()).visibility, 'private');
  assert.equal((await configCommand(['check'])).status, 'valid');
  await configCommand(['reset']);
  assert.deepEqual(await loadConfig(), emptyConfig());
  assert.deepEqual(JSON.parse(await readFile(configFile(), 'utf8')), emptyConfig());
});

test('config rejects invalid values, unknown fields, and missing or null defaults', () => {
  for (const defaults of [null, undefined, [], { visibility: 'other' }, { duration: 61 }, { cookie: 'secret' }]) {
    assert.throws(() => validateConfig({ version: 1, defaults, presets: {}, activePreset: null }));
  }
  assert.throws(() => validateConfig({ ...emptyConfig(), activePreset: 'missing' }), /active preset/);
  assert.throws(() => validateConfig({ ...emptyConfig(), unexpected: true }), /Unknown config key/);
  assert.throws(() => validateConfig({ ...emptyConfig(), presets: { '../escape': {} } }), /Preset names/);
});

test('CLI preserves a video link and parses metadata, preset and clipping options', () => {
  const url = 'https://example.com/video?a=1&b=2';
  const options = parseArgs([url, '--visibility=public', '-r', ' ', '-d', 'Description', '--start', '12.5', '--duration', '20', '-q', '720p', '-o', 'C:\\Export clips', '-p', 'share', '--json']);
  assert.equal(options.command, 'upload');
  assert.equal(options.source, url);
  assert.equal(options.json, true);
  assert.equal(options.preset, 'share');
  assert.deepEqual(options.overrides, { visibility: 'public', rename: ' ', description: 'Description', start: 12.5, duration: 20, quality: '720p', output: 'C:\\Export clips' });
  assert.equal(parseArgs(['--', '-clip.mp4']).source, '-clip.mp4');
  assert.equal(parseArgs(['resume', 'job-id', '--visibility', 'private']).overrides.visibility, 'private');
});

test('CLI filters account lists and validates command-specific flags and conflicting settings', () => {
  const options = parseArgs(['list', 'private', '--all', '--limit', '10', '--sort', 'views', '--order', 'asc', '--status', 'ready', '--json']);
  assert.equal(options.command, 'list');
  assert.equal(options.all, true);
  assert.deepEqual(options.filters, { page: 1, limit: 10, sort: 'views', dir: 'asc', status: 'ready', visibility: 'private' });
  assert.equal(parseArgs(['analytics', '--days', '90']).days, 90);
  assert.equal(parseArgs(['history']).command, 'jobs');
  assert.equal(parseArgs(['aliases', 'list']).command, 'alias');
  for (const args of [
    ['file.mp4', '--duration', '0'], ['file.mp4', '--duration', '61'], ['file.mp4', '--start', '-1'],
    ['file.mp4', '--rename', 'a', '--title', 'b'], ['file.mp4', '--color', '--no-color'],
    ['file.mp4', '--preset', 'one', '--profile', 'two'], ['one.mp4', 'two.mp4'],
    ['list', 'private', '--visibility', 'public'], ['list', '--all', '--page', '2'],
    ['list', '--limit', '51'], ['list', '--sort', 'unknown'], ['list', '--status', 'unknown'],
    ['analytics', '--days', '14'], ['resume', 'id', '--dry-run'], ['edit', '123'],
    ['file.mp4', '--rename', 'first\nsecond'], ['file.mp4', '--quality', '0p'],
  ]) assert.throws(() => parseArgs(args), undefined, `Arguments must be rejected: ${JSON.stringify(args)}`);
});

test('aliases create and remove only their managed wrappers in the explicit directory', async t => {
  const directory = await temporaryDirectory(t, 'smup-alias-test-');
  const options = { binDir: directory, platform: 'win32' };
  const added = await aliasCommand(['add', 'smap'], options);
  assert.equal(added.status, 'added');
  assert.equal(added.paths.length, 3);
  for (const file of added.paths) {
    assert.equal(path.dirname(file), directory);
    assert.match(await readFile(file, 'utf8'), /smup-managed-alias-v1/);
  }
  const listed = await aliasCommand(['list'], options);
  assert.equal(listed.aliases.find(item => item.name === 'smap').builtin, false);
  assert.equal(listed.aliases.find(item => item.name === 'smap').present, true);
  await aliasCommand(['remove', 'smap'], options);
  for (const file of added.paths) await assert.rejects(access(file), error => error.code === 'ENOENT');
  await assert.rejects(aliasCommand(['remove', 'smap'], options), /does not exist/);
});

test('alias management protects built-ins, unrelated commands, and an alias with one replaced wrapper', async t => {
  const directory = await temporaryDirectory(t, 'smup-alias-protect-test-');
  const options = { binDir: directory, platform: 'win32' };
  for (const name of ['smup', 'smush']) {
    await assert.rejects(aliasCommand(['add', name], options), /built-in/);
    await assert.rejects(aliasCommand(['remove', name], options), /built-in/);
  }
  const protectedFile = path.join(directory, 'existing.exe');
  await writeFile(protectedFile, 'not managed');
  await assert.rejects(aliasCommand(['add', 'existing'], options), /already exists/);
  assert.equal(await readFile(protectedFile, 'utf8'), 'not managed');
  const added = await aliasCommand(['add', 'mixed'], options);
  const replacedFile = path.join(directory, 'mixed.ps1');
  await writeFile(replacedFile, 'unrelated replacement');
  await assert.rejects(aliasCommand(['remove', 'mixed'], options), /No files were removed/);
  for (const file of added.paths) await access(file);
  assert.equal(await readFile(replacedFile, 'utf8'), 'unrelated replacement');
  await assert.rejects(aliasCommand(['add', '../escape'], options), /Alias names/);
});

test('JSON output remains a single uncolored schema record while progress goes to stderr', async () => {
  const stdout = recordingStream(true), stderr = recordingStream(true);
  const terminal = createTerminal({ json: true, color: true, stdout, stderr, env: {} });
  try {
    await terminal.step('Loading videos', async () => {
      terminal.progress(8, 10, { started: Date.now() - 1000, initial: 0 });
      terminal.download('50%');
    });
    terminal.json({ command: 'list', status: 'ok', items: [] });
    assert.deepEqual(JSON.parse(stdout.text), { schemaVersion: 1, command: 'list', status: 'ok', items: [] });
    assert.equal(stdout.text.trim().split('\n').length, 1);
    assert.doesNotMatch(stdout.text + stderr.text, /\x1b/);
    assert.match(stderr.text, /Loading videos/);
  } finally { terminal.close(); }
});

test('TTY loading and transfer progress update in place and retain VEO status colors', async () => {
  const stdout = recordingStream(true), stderr = recordingStream(true);
  const terminal = createTerminal({ stdout, stderr, env: {} });
  try {
    terminal.label('Title', 'Clip', 'title');
    await terminal.step('Uploading video', async () => {
      terminal.progress(5, 10, { started: Date.now() - 1000, initial: 0 });
      terminal.progress(10, 10, { started: Date.now() - 1000, initial: 0 });
      return 'result';
    });
    assert.match(stderr.text, /\r\x1b\[2K/);
    assert.match(stderr.text, /50%/);
    assert.match(stderr.text, /100%/);
    assert.match(stderr.text, /\x1b\[90m/);
    assert.match(stderr.text, /\x1b\[32mdone/);
    assert.match(stdout.text, /\x1b\[1mClip/);
    assert.equal(stderr.text.split('\n').filter(line => line.includes('Uploading video')).length, 1);
  } finally { terminal.close(); }
});

test('NO_COLOR and explicit color disabling remove color codes from terminal messages', () => {
  for (const options of [{ env: { NO_COLOR: '' } }, { color: false, env: {} }]) {
    const stdout = recordingStream(true), stderr = recordingStream(true);
    const terminal = createTerminal({ stdout, stderr, ...options });
    terminal.output('Ready', 'success');
    terminal.error('Problem');
    terminal.close();
    assert.equal(stdout.text, 'Ready\n');
    assert.equal(stderr.text, 'smup: Problem\n');
  }
});
test('terminal animation pauses while a confirmation prompt is waiting for input', async () => {
  const stdout = recordingStream(true), stderr = recordingStream(true);
  const terminal = createTerminal({ stdout, stderr, env: {} });
  try {
    await terminal.step('Checking limits', () => terminal.suspend(async () => {
      const before = stderr.text;
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(stderr.text, before, 'No spinner redraw may overwrite a pending question');
      return false;
    }));
    assert.match(stderr.text, /done/);
  } finally { terminal.close(); }
});
