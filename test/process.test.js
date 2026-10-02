import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process.js';

const inspect = ['--input-type=module', '-e', `
  console.log(JSON.stringify({
    inherited: Object.keys(process.env).filter(key => /^(?:smolup|smop|smup)_cookie(?:_file)?$/i.test(key)),
    preserved: process.env.SMOLUP_PROCESS_TEST,
  }));
`];

test('media subprocesses discard cookies from explicit environments without changing the caller', async () => {
  const env = { ...process.env, SMOLUP_COOKIE: 'test-only-cookie', SMOLUP_COOKIE_FILE: 'test-only-file',
    SMOP_COOKIE: 'test-only-cookie', smup_cookie_file: 'test-only-file', SMOLUP_PROCESS_TEST: 'kept' };
  const result = await run(process.execPath, inspect, { env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { inherited: [], preserved: 'kept' });
  assert.equal(env.SMOLUP_COOKIE, 'test-only-cookie');
  assert.equal(env.smup_cookie_file, 'test-only-file');
});

test('media subprocesses also discard cookies inherited from the parent environment', async t => {
  const values = { SMOLUP_COOKIE: 'test-only-cookie', SMUP_COOKIE_FILE: 'test-only-file', SMOLUP_PROCESS_TEST: 'kept' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  const result = await run(process.execPath, inspect);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { inherited: [], preserved: 'kept' });
  assert.equal(process.env.SMOLUP_COOKIE, 'test-only-cookie');
});
