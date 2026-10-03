import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal, formatBytes, formatDuration } from '../src/terminal.js';
import { HELP, COMMAND_HELP } from '../src/help.js';

const strip = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
function recording(isTTY = false, columns = 120) {
  const chunks = [];
  return { isTTY, columns, write(value) { chunks.push(String(value)); }, get text() { return chunks.join(''); } };
}
function terminalFor(options = {}) {
  const stdout = recording(options.isTTY), stderr = recording(options.isTTY);
  return { stdout, stderr, terminal: createTerminal({ stdout, stderr, env: {}, ...options }) };
}

test('help keeps every line, indentation and option with distinct semantic colors', () => {
  const stdout = recording(true, 20), stderr = recording(true);
  const terminal = createTerminal({ stdout, stderr, env: {} });
  terminal.help(HELP);
  terminal.close();
  assert.equal(strip(stdout.text), `${HELP.trimEnd()}\n`);
  assert.match(stdout.text, /\x1b\[1;36mUsage:/);
  assert.match(stdout.text, /\x1b\[36msmolup/);
  assert.match(stdout.text, /\x1b\[33m--visibility/);
  assert.match(stdout.text, /\x1b\[35m<title>/);
  assert.match(stdout.text, /\x1b\[90m/);
  assert.ok(stdout.text.split('\n').length > 60, 'Full help must remain multiline even in a narrow terminal');
});

test('all command help stays intact with colors enabled or disabled', () => {
  for (const color of [true, false]) {
    for (const [command, text] of Object.entries(COMMAND_HELP)) {
      const { terminal, stdout } = terminalFor({ isTTY: true, color });
      terminal.help(text);
      terminal.close();
      assert.equal(strip(stdout.text), `${text.trimEnd()}\n`, command);
      if (color) assert.match(stdout.text, /\x1b\[36msmolup/, command);
      else assert.doesNotMatch(stdout.text, /\x1b/, command);
    }
  }
});

test('redirected output is plain by default and explicit force colors all human paths', async () => {
  for (const forceColor of [false, true]) {
    const { terminal, stdout, stderr } = terminalFor({ forceColor });
    terminal.output('Video ready.', 'success');
    terminal.label('Visibility', 'private');
    terminal.help('Usage:\n  smolup version --json  Check version\n');
    terminal.table(['Job', 'Status', 'Views'], [['abc123', 'ready', 42]]);
    terminal.object({ title: 'Clip', views: 42, ready: true, missing: null });
    await terminal.step('Loading VEO', async () => {
      terminal.progress(10, 10, { started: Date.now() - 1000, initial: 0 });
    });
    terminal.say('Resume: smolup resume abc123');
    terminal.error('Unknown option --wat');
    terminal.close();
    assert.doesNotMatch(stdout.text + stderr.text, /\r\x1b\[2K/, 'Redirected streams must not acquire cursor animation');
    if (forceColor) {
      assert.match(stdout.text, /\x1b\[32mVideo ready/);
      assert.match(stdout.text, /\x1b\[33mprivate/);
      assert.match(stderr.text, /\x1b\[36mLoading VEO/);
      assert.match(stderr.text, /\x1b\[31msmolup: Unknown option/);
      for (const line of (stdout.text + stderr.text).trimEnd().split('\n').filter(line => line.trim())) {
        assert.match(line, /\x1b\[/, strip(line));
      }
    } else assert.doesNotMatch(stdout.text + stderr.text, /\x1b/);
  }
});

test('color precedence respects JSON, explicit disabling, NO_COLOR and FORCE_COLOR', () => {
  const cases = [
    [{ isTTY: true }, true],
    [{ isTTY: false }, false],
    [{ env: { FORCE_COLOR: '1' } }, true],
    [{ env: { FORCE_COLOR: '' } }, true],
    [{ isTTY: true, env: { FORCE_COLOR: '0' } }, false],
    [{ isTTY: true, env: { NO_COLOR: '' } }, false],
    [{ env: { NO_COLOR: '', FORCE_COLOR: '1' } }, false],
    [{ forceColor: true, env: { NO_COLOR: '' } }, true],
    [{ color: false, forceColor: true, env: { FORCE_COLOR: '1' } }, false],
    [{ json: true, isTTY: true, forceColor: true, env: { FORCE_COLOR: '1' } }, false],
    [{ isTTY: true, env: { TERM: 'dumb' } }, false],
    [{ forceColor: true, env: { TERM: 'dumb' } }, true],
  ];
  for (const [options, colored] of cases) {
    const { terminal, stdout, stderr } = terminalFor(options);
    terminal.output('Ready', 'success');
    terminal.error('Problem');
    terminal.close();
    assert.equal(/\x1b/.test(stdout.text + stderr.text), colored, JSON.stringify(options));
  }
});

test('table colors preserve visible cell alignment and color status and metrics independently', () => {
  const { terminal, stdout } = terminalFor({ isTTY: true });
  terminal.table(['Job', 'Status', 'Views', 'Title'], [
    ['abc123', 'ready', 12, 'Long clip'], ['z9y8x7', 'failed', 3, 'Short'],
  ]);
  terminal.close();
  assert.equal(strip(stdout.text), 'Job     Status  Views  Title\n──────  ──────  ─────  ─────────\nabc123  ready      12  Long clip\nz9y8x7  failed      3  Short\n');
  assert.match(stdout.text, /\x1b\[36mabc123/);
  assert.match(stdout.text, /\x1b\[32mready/);
  assert.match(stdout.text, /\x1b\[31mfailed/);
  assert.match(stdout.text, /\x1b\[94m12/);
});

test('human object output highlights JSON syntax while machine JSON is always plain', () => {
  const { terminal, stdout } = terminalFor({ isTTY: true, forceColor: true });
  const data = { title: 'A "clip"', views: 10, ready: true, previous: null };
  terminal.object(data);
  terminal.close();
  assert.deepEqual(JSON.parse(strip(stdout.text)), data);
  assert.match(stdout.text, /\x1b\[36m"title"/);
  assert.match(stdout.text, /\x1b\[32m"A/);
  assert.match(stdout.text, /\x1b\[94m10/);
  assert.match(stdout.text, /\x1b\[33mtrue/);
  const jsonOutput = terminalFor({ isTTY: true, json: true, forceColor: true });
  jsonOutput.terminal.json({ command: 'info', status: 'ok', data });
  jsonOutput.terminal.close();
  assert.doesNotMatch(jsonOutput.stdout.text + jsonOutput.stderr.text, /\x1b/);
  assert.deepEqual(JSON.parse(jsonOutput.stdout.text).data, data);
});

test('incoming terminal controls are removed before rendering but generated colors survive', () => {
  const { terminal, stdout, stderr } = terminalFor({ isTTY: true });
  terminal.label('Title', '\x1b[31munsafe\x1b[0m\x1b]0;fake-title\x07');
  terminal.say('Resume: smolup resume abc123\nStudio: https://smolish.com/studio');
  assert.equal(strip(stdout.text), 'Title: unsafe\n');
  assert.doesNotMatch(stdout.text, /fake-title|\x07/);
  assert.match(stdout.text, /\x1b\[35munsafe/);
  assert.equal(strip(stderr.text).split('\n').filter(Boolean).length, 2);
  assert.match(terminal.prompt('Attempt anyway? [y/N] '), /\x1b\[1;33m/);
  terminal.close();
});

test('interactive transfer retains colored in-place redraws and final status', async () => {
  const { terminal, stderr } = terminalFor({ isTTY: true });
  await terminal.step('Uploading clip', async () => {
    terminal.progress(5, 10, { started: Date.now() - 1000, initial: 0 });
    terminal.download('100% received; processing');
  });
  terminal.close();
  assert.match(stderr.text, /\r\x1b\[2K\x1b\[36mUploading clip/);
  assert.match(stderr.text, /\x1b\[94m50/);
  assert.match(stderr.text, /\x1b\[32mdone/);
  assert.equal(strip(stderr.text).split('\n').filter(line => line.includes('Uploading clip')).length, 1);
});

test('interactive progress draws a spinner and a bar sized to the percentage', async () => {
  const { terminal, stderr } = terminalFor({ isTTY: true });
  await terminal.step('Uploading clip', async () => {
    terminal.progress(5, 10, { started: Date.now() - 1000, initial: 0 });
  });
  terminal.close();
  const drawn = strip(stderr.text);
  assert.match(drawn, /[⠋|] Uploading clip  █{10}░{10}  50%/);
});

test('byte sizes and durations pick readable units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(30 * 1048576), '30.0 MiB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.50 GiB');
  assert.equal(formatDuration(9.2), '10s');
  assert.equal(formatDuration(754), '12m 34s');
  assert.equal(formatDuration(3720), '1h 02m');
});
