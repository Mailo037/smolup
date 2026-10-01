import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { PACKAGE_NAME, VERSION } from '../src/identity.js';
import { compareVersions, validateRelease, checkVersion, updatePackage, installationContext,
  resolveNpmCommand, repairTools, NPM_REGISTRY } from '../src/maintenance.js';
import { parseArgs } from '../src/arguments.js';
import { main } from '../src/cli.js';

const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const metadata = (version = '1.0.0') => ({ name: PACKAGE_NAME, version,
  dist: { tarball: `${NPM_REGISTRY}${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`, integrity } });
const checked = (version = '1.0.0') => ({ status: 'update-available', package: PACKAGE_NAME, installed: VERSION,
  latest: version, published: true, updateAvailable: true, registry: NPM_REGISTRY, checkedAt: new Date().toISOString() });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const npm = { file: '/node-executable', args: ['/npm/npm-cli.js'] };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smop-maintenance-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('version ordering handles stable releases, prereleases and invalid registry versions', () => {
  const ascending = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
    '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 1; i < ascending.length; i++) assert.equal(compareVersions(ascending[i - 1], ascending[i]), -1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+other.2'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  for (const version of ['01.2.3', '1.2', '1.2.3;echo secrets', '--global', '1.2.3-01', 'v1.2.3', '1.2.3\n']) {
    assert.throws(() => compareVersions(version, '1.0.0'), /invalid version/);
  }
});

test('release metadata must identify this package, an npm-hosted exact tarball and a valid integrity value', () => {
  assert.deepEqual(validateRelease(metadata()), { version: '1.0.0', tarball: metadata().dist.tarball, integrity });
  const invalid = [
    { ...metadata(), name: 'another-package' },
    { ...metadata(), version: '1.0.0 --registry=https://example.com' },
    { ...metadata(), dist: { ...metadata().dist, tarball: 'https://example.com/package.tgz' } },
    { ...metadata(), dist: { ...metadata().dist, tarball: metadata().dist.tarball.replace('1.0.0', '0.9.0') } },
    { ...metadata(), dist: { ...metadata().dist, tarball: `${metadata().dist.tarball}?token=secret` } },
    { ...metadata(), dist: { ...metadata().dist, integrity: 'sha1-old-hash' } },
    { ...metadata(), dist: { ...metadata().dist, integrity: 'sha512-invalid' } },
    { ...metadata(), dist: { ...metadata().dist, integrity: undefined } },
  ];
  for (const value of invalid) assert.throws(() => validateRelease(value), /registry/);
});

test('version checks use the official registry with no redirects or credentials and return truthful version status', async () => {
  let request;
  const fetchImpl = async (url, options) => { request = { url, options }; return json(metadata('0.4.1')); };
  const result = await checkVersion({ installed: '0.4.0', fetchImpl });
  assert.equal(request.url, `${NPM_REGISTRY}${PACKAGE_NAME}/latest`);
  assert.deepEqual(request.options.headers, { accept: 'application/json' });
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.status, 'update-available');
  assert.equal(result.latest, '0.4.1');
  assert.equal(result.installed, '0.4.0');
  assert.equal((await checkVersion({ installed: '0.4.1', fetchImpl })).status, 'current');
  assert.equal((await checkVersion({ installed: '0.5.0', fetchImpl })).status, 'ahead');
});

test('an unpublished package is a friendly result and never attempts npm installation', async () => {
  const check = () => checkVersion({ fetchImpl: async () => json({ error: 'Not found' }, 404) });
  const result = await updatePackage({ check, runImpl: () => assert.fail('Unpublished packages must not invoke npm') });
  assert.equal(result.status, 'unpublished');
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
  assert.match(result.message, /has not been published/);
});

test('version checks reject malformed, oversized, non-JSON and unavailable registry replies', async () => {
  for (const response of [
    json({ ...metadata(), name: 'unrelated' }),
    new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{bad json', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '300000' } }),
    json({ error: 'unavailable' }, 503),
  ]) await assert.rejects(checkVersion({ fetchImpl: async () => response }), /registry/);
  await assert.rejects(checkVersion({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /Cannot reach/);
});

test('registry requests have a bounded timeout and honor explicit cancellation', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    const hold = setTimeout(() => resolve(json(metadata())), 1000);
    signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(checkVersion({ timeoutMs: 5, fetchImpl }), /timed out/);
  const controller = new AbortController();
  const pending = checkVersion({ signal: controller.signal, fetchImpl });
  controller.abort(new Error('Cancelled by user'));
  await assert.rejects(pending, /Cancelled by user/);
});

test('update --check and current versions never run npm or mutate source files', async () => {
  const fail = () => assert.fail('Readonly maintenance must not invoke npm');
  assert.equal((await updatePackage({ checkOnly: true, check: async () => checked(), runImpl: fail })).status, 'update-available');
  const current = { ...checked(VERSION), updateAvailable: false, status: 'current' };
  assert.equal((await updatePackage({ check: async () => current, runImpl: fail })).status, 'current');
});

test('npm invocation resolves npm-cli.js and executes it with Node instead of a command shell', async t => {
  const directory = await temporary(t);
  const execPath = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  const npmPath = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(path.dirname(npmPath), { recursive: true });
  await writeFile(npmPath, '// npm fixture');
  assert.deepEqual(await resolveNpmCommand({ execPath, env: { PATH: '', npm_execpath: 'npm.cmd' } }), { file: execPath, args: [npmPath] });
});

test('source and npm-linked installations receive exact install guidance without an automatic install', async t => {
  const base = await temporary(t);
  const source = path.join(base, 'source'), globalRoot = path.join(base, 'global');
  await mkdir(source); await mkdir(globalRoot);
  const calls = [];
  const runImpl = async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: `${globalRoot}\n`, stderr: '' }; };
  const check = async () => checked();
  const plain = await updatePackage({ check, runImpl, npmCommand: npm, directory: source });
  assert.equal(plain.status, 'manual-install');
  assert.equal(plain.installation, 'source');
  assert.equal(plain.installCommand, `npm install --global ${PACKAGE_NAME}@1.0.0 --registry=${NPM_REGISTRY}`);
  await symlink(source, path.join(globalRoot, PACKAGE_NAME), 'junction');
  const linked = await updatePackage({ check, runImpl, npmCommand: npm, directory: source });
  assert.equal(linked.installation, 'linked');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args.join(' ') === '/npm/npm-cli.js root --global'));
});

test('a genuine global update installs an exact verified version and strips Smolish credentials from npm', async t => {
  const base = await temporary(t), globalRoot = path.join(base, 'global');
  const directory = path.join(globalRoot, PACKAGE_NAME);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
  const calls = [];
  const runImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('root')) return { code: 0, stdout: `${globalRoot}\n`, stderr: '' };
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' }));
    return { code: 0, stdout: 'installed', stderr: '' };
  };
  const result = await updatePackage({ check: async () => checked(), runImpl, npmCommand: npm, directory,
    env: { PATH: '/bin', SMOP_COOKIE: 'private', smop_cookie_file: '/secret', sMoP_CoOkIe: 'private-too',
      SMUP_COOKIE: 'legacy-private', smup_cookie_file: '/legacy-secret', sMuP_CoOkIe: 'legacy-private-too' } });
  assert.equal(result.status, 'updated');
  assert.equal(result.installed, '1.0.0');
  assert.equal(result.previousInstalled, VERSION);
  assert.deepEqual(calls[1].args, ['/npm/npm-cli.js', 'install', '--global', `${PACKAGE_NAME}@1.0.0`,
    `--registry=${NPM_REGISTRY}`, '--no-audit', '--no-fund']);
  for (const call of calls) assert.deepEqual(call.options.env, { PATH: '/bin' });
});

test('npm success must be followed by verification of the installed package version', async t => {
  const base = await temporary(t), directory = path.join(base, PACKAGE_NAME);
  await mkdir(directory); await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
  const runImpl = async (_file, args) => ({ code: 0, stdout: args.includes('root') ? `${base}\n` : '', stderr: '' });
  await assert.rejects(updatePackage({ check: async () => checked(), runImpl, npmCommand: npm, directory }), /was not confirmed/);
  await assert.rejects(updatePackage({ check: async () => ({ ...checked(), package: 'other' }), runImpl: () => assert.fail('Unverified package must not run npm') }), /could not be verified/);
  await assert.rejects(installationContext({ npmCommand: npm, directory, runImpl: async () => ({ code: 0, stdout: 'relative/path', stderr: '' }) }), /invalid global/);
});

const backend = () => ({
  async resolveBackend() { return { ytDlp: '/tools/yt-dlp', ffmpegLocation: '/tools' }; },
  async inspectBackend() { return { release: '2026.08.19', errors: [], ytDlp: { present: true, source: 'managed', verified: true },
    ffmpeg: { present: true }, ffprobe: { present: true } }; },
});

test('doctor fix prepares the VEO backend and executes all three tool version probes', async () => {
  const calls = [], statuses = [];
  const result = await repairTools({ backend: backend(), onStatus: value => statuses.push(value),
    runImpl: async (file, args) => {
      calls.push({ file, args });
      const name = path.basename(file).replace(/\.exe$/, '');
      return { code: 0, stdout: name === 'yt-dlp' ? '2026.08.19\n' : `${name} version 8.0\n`, stderr: '' };
    } });
  assert.equal(result.status, 'repaired');
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks.map(check => check.name), ['yt-dlp', 'ffmpeg', 'ffprobe']);
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['-version'], ['-version']]);
  assert.equal(statuses.length, 3);
});

test('doctor fix rejects failed probes and tools that fail final integrity inspection', async () => {
  await assert.rejects(repairTools({ backend: backend(), runImpl: async () => ({ code: 1, stdout: '', stderr: 'failure' }) }), /failed its version check/);
  await assert.rejects(repairTools({ backend: backend(), runImpl: async () => ({ code: 0, stdout: 'a different executable', stderr: '' }) }), /failed its version check/);
  const damaged = backend();
  damaged.inspectBackend = async () => ({ release: '2026.08.19', errors: [], ytDlp: { present: true, source: 'managed', verified: false },
    ffmpeg: { present: true }, ffprobe: { present: true } });
  await assert.rejects(repairTools({ backend: damaged, runImpl: async file => {
    const name = path.basename(file).replace(/\.exe$/, '');
    return { code: 0, stdout: name === 'yt-dlp' ? '2026.08.19' : `${name} version 8.0`, stderr: '' };
  } }), /final backend inspection/);
});

test('maintenance argument syntax rejects misplaced flags and preserves help color preferences', () => {
  assert.equal(parseArgs(['doctor', 'fix']).command, 'doctorfix');
  assert.equal(parseArgs(['doctorfix']).command, 'doctorfix');
  assert.equal(parseArgs(['update', '--check']).check, true);
  assert.equal(parseArgs(['version']).command, 'version');
  assert.equal(parseArgs(['--help', '--no-color']).overrides.color, false);
  assert.equal(parseArgs(['--version', '--color']).overrides.color, true);
  assert.throws(() => parseArgs(['--help', '--color', '--no-color']), /either --color/);
  assert.equal(parseArgs(['doctor', 'fix', '--online']).online, true);
  for (const args of [['version', '--check'], ['update', 'anything'], ['doctorfix', '--dry-run']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('maintenance CLI commands work without a Smolish login and produce clean structured output', async t => {
  const directory = await temporary(t);
  const names = ['SMOP_HOME', 'SMOP_CONFIG', 'SMOP_COOKIE', 'SMOP_COOKIE_FILE', 'SMUP_HOME', 'SMUP_CONFIG', 'SMUP_COOKIE', 'SMUP_COOKIE_FILE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.SMOP_HOME = directory;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const invoke = async (args, extra = {}) => {
    let output = '', errors = '';
    const code = await main([...args, '--json'], {
      stdout: { isTTY: false, write: text => { output += text; } }, stderr: { isTTY: false, write: text => { errors += text; } },
      api: { checkAuth: () => assert.fail('Maintenance must not authenticate with Smolish') }, ...extra,
    });
    assert.equal(code, 0); assert.doesNotMatch(output + errors, /\x1b/);
    assert.equal(output.trim().split('\n').length, 1);
    return JSON.parse(output);
  };
  const version = await invoke(['version'], { checkVersion: async () => checked() });
  assert.equal(version.command, 'version'); assert.equal(version.latest, '1.0.0');
  const update = await invoke(['update', '--check'], { updatePackage: async options => { assert.equal(options.checkOnly, true); return checked(); } });
  assert.equal(update.command, 'update');
  const fixed = await invoke(['doctor', 'fix'], { repairTools: async () => ({ status: 'repaired', ready: true, checks: [] }) });
  assert.equal(fixed.command, 'doctorfix'); assert.equal(fixed.ready, true);
  const installed = await invoke(['--version']);
  assert.equal(installed.version, VERSION);
});
