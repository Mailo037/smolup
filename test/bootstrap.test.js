import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../src/bootstrap.js';
import { VERSION } from '../src/identity.js';

function stream() {
  const chunks = [];
  return { isTTY: false, write(value) { chunks.push(String(value)); }, get text() { return chunks.join(''); } };
}
function fixture() { return { stdout: stream(), stderr: stream(), env: {}, hasVeo: () => false }; }

test('version and help work without VEO and never install dependencies', async () => {
  for (const args of [['--version', '--json'], ['doctorfix', '--help', '--json'], ['help', 'update', '--json']]) {
    const io = fixture();
    let repairs = 0;
    const code = await launch(args, { ...io, repair() { repairs++; } });
    assert.equal(code, 0);
    assert.equal(repairs, 0);
    const output = JSON.parse(io.stdout.text);
    assert.equal(output.schemaVersion, 1);
    if (args[0] === '--version') assert.equal(output.version, VERSION);
    else assert.match(output.text, /smolup/);
    assert.doesNotMatch(io.stdout.text + io.stderr.text, /\x1b/);
  }
});

test('human version output keeps the new command name when VEO is missing', async () => {
  const io = fixture();
  assert.equal(await launch(['--version'], { ...io, repair: () => assert.fail('Version must not install dependencies') }), 0);
  assert.equal(io.stdout.text, `smolup ${VERSION}\n`);
  assert.equal(io.stderr.text, '');
});

test('missing VEO reports an actionable JSON error and only explicit repair installs', async () => {
  for (const args of [['whoami', '--json'], ['doctorfix', '--unknown', '--json'], ['https://example.com/video', '--json']]) {
    const io = fixture();
    let repairs = 0;
    assert.equal(await launch(args, { ...io, repair() { repairs++; } }), 1);
    assert.equal(repairs, 0);
    assert.equal(JSON.parse(io.stdout.text).status, 'failed');
    assert.match(io.stderr.text, /smolup doctorfix/);
  }
});

test('explicit repair restores VEO before handing arguments to the CLI', async () => {
  const io = fixture();
  let installed = false, called = 0;
  const args = ['doctor', 'fix', '--json'];
  const code = await launch(args, { ...io, hasVeo: () => installed,
    repair: async signal => { assert.equal(signal.aborted, false); installed = true; },
    load: async () => ({ main: async (actual, streams) => {
      called++;
      assert.deepEqual(actual, args);
      assert.equal(streams.stdout, io.stdout);
      io.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'ready' }));
      return 0;
    } }),
  });
  assert.equal(code, 0);
  assert.equal(called, 1);
  assert.equal(JSON.parse(io.stdout.text).status, 'ready');
  assert.doesNotMatch(io.stdout.text + io.stderr.text, /\x1b/);
});

test('repair failures never start the CLI and cannot report success', async () => {
  const io = fixture();
  let imports = 0;
  const code = await launch(['doctorfix', '--json'], { ...io,
    repair: async () => { throw new Error('Synthetic repair failure'); },
    load: async () => { imports++; throw new Error('Should not import'); },
  });
  assert.equal(code, 1);
  assert.equal(imports, 0);
  assert.equal(JSON.parse(io.stdout.text).status, 'failed');
});
