import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { main } from '../src/cli.js';
import { loadAuth, saveAuth } from '../src/auth.js';
import { configFile } from '../src/config.js';

function stream(isTTY = false) {
  const chunks = [];
  return { isTTY, columns: 180, write(value) { chunks.push(String(value)); }, get text() { return chunks.join(''); } };
}
async function isolated(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smolup-commands-'));
  const names = ['SMOLUP_HOME', 'SMOLUP_CONFIG', 'SMOLUP_COOKIE', 'SMOLUP_COOKIE_FILE', 'SMOP_HOME', 'SMUP_HOME', 'SMOP_CONFIG', 'SMUP_CONFIG', 'SMOP_COOKIE', 'SMUP_COOKIE', 'SMOP_COOKIE_FILE', 'SMUP_COOKIE_FILE', 'EDITOR', 'VISUAL'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.SMOLUP_HOME = directory;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function invoke(args, dependencies = {}) {
  const stdout = stream(), stderr = stream();
  const code = await main([...args, '--json'], { ...dependencies, stdout, stderr });
  assert.equal(stdout.text.trim().split('\n').length, 1, `one record for ${args.join(' ')}`);
  assert.doesNotMatch(stdout.text + stderr.text, /\x1b/);
  return { code, data: JSON.parse(stdout.text), stderr: stderr.text };
}

test('every command and documented synonym has non-mutating clean JSON help', async t => {
  await isolated(t);
  const commands = ['upload', 'setup', 'whoami', 'resume', 'list', 'info', 'analytics', 'edit', 'config', 'preset',
    'alias', 'jobs', 'doctor', 'doctorfix', 'version', 'update', 'storage', 'watchdog', 'help',
    'history', 'presets', 'aliases', 'profile', 'limits', 'watch'];
  for (const command of commands) {
    const output = await invoke([command, '--help']);
    assert.equal(output.code, 0, command);
    assert.equal(output.data.command, 'help');
    assert.match(output.data.text, /smolup/);
  }
  assert.equal((await invoke(['doctor', 'fix', '--help'])).code, 0);
  const globalHelp = await invoke(['--help']);
  assert.match(globalHelp.data.text, /Account and videos:/);
  assert.match(globalHelp.data.text, /smolup update \[--check\]/);
});

test('config, presets and aliases complete their command lifecycle through the CLI', async t => {
  const directory = await isolated(t);
  const bins = path.join(directory, 'bin');
  await mkdir(bins);
  const commands = [
    ['config', 'show'], ['config', 'path'], ['config', 'set', 'visibility', 'public'], ['config', 'check'],
    ['config', 'unset', 'visibility'], ['preset', 'add', 'shorts', '--duration', '30'], ['preset', 'show', 'shorts'],
    ['preset', 'use', 'shorts'], ['preset', 'list'], ['preset', 'reset'], ['preset', 'remove', 'shorts'],
    ['alias', 'list', '--bin-dir', bins], ['alias', 'add', 'clipgo', '--bin-dir', bins],
    ['alias', 'list', '--bin-dir', bins], ['alias', 'remove', 'clipgo', '--bin-dir', bins], ['config', 'reset'], ['jobs'],
  ];
  for (const args of commands) assert.equal((await invoke(args)).code, 0, args.join(' '));
  assert.equal((await invoke(['alias', 'add', 'smolup', '--bin-dir', bins])).code, 1);
});

test('watchdog registration, queries, stop, remove and invalid retry use isolated state', async t => {
  const directory = await isolated(t);
  const folder = path.join(directory, 'inbox');
  await mkdir(folder);
  const commands = [
    ['watchdog', 'add', 'clips', folder, '--split', '-r', '{filename} Part {part}'],
    ['watchdog', 'list'], ['watchdog', 'show', 'clips'], ['watchdog', 'status', 'clips'], ['watchdog', 'stop', 'clips'],
  ];
  for (const args of commands) assert.equal((await invoke(args)).code, 0, args.join(' '));
  assert.equal((await invoke(['watchdog', 'retry', 'clips'])).code, 1);
  assert.equal((await invoke(['watchdog', 'remove', 'clips'])).code, 0);
  assert.equal((await invoke(['watchdog', 'show', 'clips'])).code, 1);
});

test('interactive config editor arguments preserve spaced paths and validate the edited document', async t => {
  const directory = await isolated(t);
  const editor = path.join(directory, 'fixture editor.cjs');
  await writeFile(editor, 'const fs = require("node:fs"); const file = process.argv[2]; const config = JSON.parse(fs.readFileSync(file)); config.defaults.visibility = "public"; fs.writeFileSync(file, JSON.stringify(config));');
  process.env.EDITOR = `"${process.execPath}" "${editor}"`;
  const stdout = stream(), stderr = stream();
  assert.equal(await main(['config', 'edit', '--no-color'], { stdout, stderr }), 0);
  assert.equal(JSON.parse(await readFile(configFile(), 'utf8')).defaults.visibility, 'public');
  assert.equal((await invoke(['config', 'edit'])).code, 1);
});

test('setup passes hidden prompt and cancellation signal, verifies the session, and retains encrypted credentials', async t => {
  await isolated(t);
  const stdout = stream(true), stderr = stream(true);
  const cookie = 'session=synthetic-setup-fixture';
  const code = await main(['setup', '--color'], { stdout, stderr,
    setupAuth: async options => {
      assert.equal(options.signal.aborted, false);
      assert.equal(options.forceColor, true);
      assert.match(options.prompt, /input hidden/);
      await saveAuth(cookie);
    },
    api: { checkAuth: async () => ({ id: '1', name: 'Fixture' }) },
  });
  assert.equal(code, 0);
  assert.equal((await loadAuth()).cookie, cookie);
  assert.match(stdout.text, /Signed in/);
  assert.doesNotMatch(stdout.text + stderr.text, /synthetic-setup-fixture/);
  const cancelled = await main(['setup', '--no-color'], { stdout: stream(), stderr: stream(),
    setupAuth: async () => { throw new DOMException('Cancelled fixture', 'AbortError'); },
  });
  assert.equal(cancelled, 130);
});

test('doctorfix online accepts its documented flag and reports sign-in failures after successful tool repair', async t => {
  await isolated(t);
  const repairTools = async () => ({ status: 'repaired', ready: true, checks: [{ name: 'ffmpeg', status: 'ok', detail: 'Fixture' }] });
  const success = await invoke(['doctor', 'fix', '--online'], { repairTools, api: { checkAuth: async () => ({ id: '1' }) } });
  assert.equal(success.code, 0);
  assert.equal(success.data.checks.at(-1).name, 'Session');
  const failure = await invoke(['doctorfix', '--online'], { repairTools, api: { checkAuth: async () => { throw new Error('Synthetic expired session'); } } });
  assert.equal(failure.code, 1);
  assert.equal(failure.data.ready, false);
  assert.equal(failure.data.checks.at(-1).status, 'failed');
});

test('account commands without authentication fail cleanly and do not begin a transfer', async t => {
  await isolated(t);
  for (const args of [['whoami'], ['list'], ['storage'], ['info', '123'], ['analytics'], ['edit', '123', '-r', 'Name'], ['resume', 'abc123']]) {
    const output = await invoke(args);
    assert.equal(output.code, 1, args.join(' '));
    assert.match(output.data.error, /smolup setup/);
  }
  const invalid = await invoke(['list', '--unknown']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.data.error, /Unknown option/);
});
