import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { PACKAGE_NAME, VERSION, COMMAND } from './identity.js';
import { run } from './process.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PACKAGE_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const MAX_REGISTRY_BYTES = 256 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parsedVersion(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('The npm registry returned an invalid version.');
  const match = VERSION_PATTERN.exec(value);
  if (!match || match[0] !== value || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('The npm registry returned an invalid version.');
  }
  return { parts: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') || [] };
}

export function compareVersions(left, right) {
  const a = parsedVersion(left), b = parsedVersion(right);
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const leftPart = a.prerelease[i], rightPart = b.prerelease[i];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    const leftNumeric = /^\d+$/.test(leftPart), rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function validateRelease(metadata, packageName = PACKAGE_NAME) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.name !== packageName) {
    throw new Error('The npm registry returned metadata for an unexpected package.');
  }
  parsedVersion(metadata.version);
  let tarball;
  try { tarball = new URL(metadata.dist?.tarball); } catch { throw new Error('The npm registry returned an invalid package download URL.'); }
  const basename = packageName.split('/').at(-1);
  const expectedPath = `/${packageName}/-/${basename}-${metadata.version}.tgz`;
  let tarballPath;
  try { tarballPath = decodeURIComponent(tarball.pathname); } catch { throw new Error('The npm registry returned an invalid package download URL.'); }
  if (tarball.origin !== new URL(NPM_REGISTRY).origin || tarball.username || tarball.password || tarball.search || tarball.hash
    || tarballPath !== expectedPath) {
    throw new Error('The npm registry returned an unexpected package download URL.');
  }
  const integrity = metadata.dist?.integrity;
  const match = typeof integrity === 'string' && /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  if (!match || match[0] !== integrity || Buffer.from(match[1], 'base64').length !== 64 || Buffer.from(match[1], 'base64').toString('base64') !== match[1]) {
    throw new Error('The npm registry returned a missing or invalid SHA-512 integrity value.');
  }
  return { version: metadata.version, tarball: tarball.href, integrity };
}

async function registryJson(response) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) throw new Error('The npm registry did not return JSON metadata.');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REGISTRY_BYTES)) throw new Error('The npm registry response is too large.');
  if (!response.body) throw new Error('The npm registry returned an empty response.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REGISTRY_BYTES) throw new Error('The npm registry response is too large.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {}); throw error;
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error('The npm registry returned unreadable JSON metadata.'); }
}

export async function checkVersion({ signal, fetchImpl = fetch, installed = VERSION, packageName = PACKAGE_NAME, timeoutMs = 10_000 } = {}) {
  parsedVersion(installed);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('Invalid npm package name.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid registry timeout.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(`${NPM_REGISTRY}${encodeURIComponent(packageName)}/latest`, {
      redirect: 'error', headers: { accept: 'application/json' }, signal: combined,
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return { status: 'unpublished', package: packageName, installed, latest: null, published: false,
        updateAvailable: false, registry: NPM_REGISTRY, checkedAt: new Date().toISOString(),
        message: `${packageName} has not been published to npm yet. The installed version is ${installed}.` };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The npm registry check failed (HTTP ${response.status}). Try ${COMMAND} version again later.`);
    }
    const release = validateRelease(await registryJson(response), packageName);
    const difference = compareVersions(release.version, installed);
    return { status: difference > 0 ? 'update-available' : difference < 0 ? 'ahead' : 'current', package: packageName,
      installed, latest: release.version, published: true, updateAvailable: difference > 0,
      registry: NPM_REGISTRY, checkedAt: new Date().toISOString() };
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new Error(`The npm registry check timed out. Try ${COMMAND} version again later.`);
    if (error instanceof TypeError) throw new Error(`Cannot reach the npm registry. Check the connection and try ${COMMAND} version again.`);
    throw error;
  }
}

function childEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/^(?:smolup|smop|smup)_cookie(?:_file)?$/i.test(key)) delete clean[key];
  return clean;
}

/** Resolve npm's JavaScript entry point so Windows never needs npm.cmd or a shell. */
export async function resolveNpmCommand({ env = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  const directory = path.dirname(execPath);
  const candidates = [env.npm_execpath, path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (platform !== 'win32') candidates.push('/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js');
  const rawPath = platform === 'win32' ? env.PATH || env.Path || '' : env.PATH || '';
  for (const entry of rawPath.split(platform === 'win32' ? ';' : ':')) {
    const binDirectory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(binDirectory)) continue;
    candidates.push(path.join(binDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (platform !== 'win32') {
      try { candidates.push(await realpath(path.join(binDirectory, 'npm'))); } catch {}
    }
  }
  for (const candidate of new Set(candidates)) {
    if (!candidate || !path.isAbsolute(candidate) || path.basename(candidate) !== 'npm-cli.js') continue;
    try { if ((await stat(candidate)).isFile()) return { file: execPath, args: [candidate] }; } catch {}
  }
  throw new Error('npm was not found. Install Node.js with npm, then retry.');
}

export const npmInvocation = resolveNpmCommand;

export async function installationContext({ signal, npmCommand, runImpl = run, directory = PACKAGE_DIRECTORY,
  packageName = PACKAGE_NAME, env = process.env } = {}) {
  const npm = npmCommand || await resolveNpmCommand({ env });
  const root = await runImpl(npm.file, [...npm.args, 'root', '--global'], { signal, env: childEnvironment(env) });
  if (root.code !== 0) throw new Error('npm could not locate its global installation directory. Run npm root --global to diagnose the installation.');
  const output = root.stdout.trim();
  if (!output || /[\r\n\0]/.test(output) || !path.isAbsolute(output)) throw new Error('npm returned an invalid global installation directory.');
  const packageDirectory = path.join(output, ...packageName.split('/'));
  const current = await realpath(directory);
  try {
    const info = await lstat(packageDirectory);
    const installedDirectory = await realpath(packageDirectory);
    if (current === installedDirectory) return { installation: info.isSymbolicLink() ? 'linked' : 'global', packageDirectory, npm };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { installation: 'source', packageDirectory, npm };
}

export async function updatePackage({ signal, checkOnly = false, check = checkVersion, runImpl = run,
  npmCommand, directory = PACKAGE_DIRECTORY, env = process.env } = {}) {
  const version = await check({ signal });
  if (checkOnly || !version.updateAvailable) return version;
  if (version.package !== PACKAGE_NAME || !version.published || compareVersions(version.latest, version.installed) <= 0) {
    throw new Error('The requested npm update could not be verified.');
  }
  const context = await installationContext({ signal, npmCommand, runImpl, directory, packageName: version.package, env });
  const specifier = `${version.package}@${version.latest}`;
  const installCommand = `npm install --global ${specifier} --registry=${NPM_REGISTRY}`;
  if (context.installation !== 'global') {
    return { ...version, status: 'manual-install', installation: context.installation, installCommand,
      message: `This is a ${context.installation === 'linked' ? 'linked source' : 'source'} installation. Run the install command from outside the checkout when you want the npm release.` };
  }
  const installed = await runImpl(context.npm.file, [...context.npm.args, 'install', '--global', specifier,
    `--registry=${NPM_REGISTRY}`, '--no-audit', '--no-fund'], { signal, env: childEnvironment(env) });
  if (installed.code !== 0) throw new Error(`npm could not install the update (exit ${installed.code ?? 'unknown'}). Run: ${installCommand}`);
  let confirmed;
  try { confirmed = JSON.parse(await readFile(path.join(context.packageDirectory, 'package.json'), 'utf8')); }
  catch { throw new Error(`npm finished, but the installed package could not be verified. Run: ${installCommand}`); }
  if (confirmed.name !== version.package || confirmed.version !== version.latest) {
    throw new Error(`npm finished, but version ${version.latest} was not confirmed. Run: ${installCommand}`);
  }
  return { ...version, status: 'updated', previousInstalled: version.installed, installed: version.latest,
    updateAvailable: false, installation: 'global', installCommand };
}

export async function repairTools({ signal, backend, runImpl = run, onStatus = () => {}, timeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid media tool timeout.');
  const veo = backend || await import('veodl/src/backend.js');
  const tools = await veo.resolveBackend({ signal, onStatus });
  const damagedMedia = report => ['ffmpeg', 'ffprobe'].some(name => report[name]?.source === 'cache' && report[name].verified === false);
  if (damagedMedia(await veo.inspectBackend({ signal }))) {
    throw new Error(`Cached media tools failed SHA-256 verification. Run ${COMMAND} doctorfix before retrying.`);
  }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const checks = [];
  for (const [name, file, args] of [
    ['yt-dlp', tools.ytDlp, ['--version']],
    ['ffmpeg', path.join(tools.ffmpegLocation, `ffmpeg${suffix}`), ['-version']],
    ['ffprobe', path.join(tools.ffmpegLocation, `ffprobe${suffix}`), ['-version']],
  ]) {
    signal?.throwIfAborted(); onStatus(`Checking ${name}`);
    const timed = AbortSignal.timeout(timeoutMs);
    let probe;
    try { probe = await runImpl(file, args, { signal: signal ? AbortSignal.any([signal, timed]) : timed, env: childEnvironment() }); }
    catch (error) {
      signal?.throwIfAborted();
      if (timed.aborted) throw new Error(`${name} did not respond within ${timeoutMs / 1000} seconds.`);
      throw new Error(`${name} could not be started. Run ${COMMAND} doctor fix again or check VEO tool overrides.`);
    }
    const firstLine = `${probe.stdout || ''}\n${probe.stderr || ''}`.split(/[\r\n]/).find(line => line.trim())?.trim();
    const versionPattern = name === 'yt-dlp' ? /^\d{4}\.\d{2}\.\d{2}(?:\.\S+)?$/ : new RegExp(`^${name} version \\S+`);
    if (probe.code !== 0 || !firstLine || !versionPattern.test(firstLine)) {
      throw new Error(`${name} failed its version check. Run ${COMMAND} doctor fix again or check VEO tool overrides.`);
    }
    checks.push({ name, status: 'ok', path: file, detail: firstLine.slice(0, 200) });
  }
  const report = await veo.inspectBackend({ signal });
  if (report.errors.length || !report.ytDlp.present || !report.ffmpeg.present || !report.ffprobe.present
    || ['managed', 'installed'].includes(report.ytDlp.source) && !report.ytDlp.verified || damagedMedia(report)) {
    throw new Error(`VEO repaired its tools, but the final backend inspection still needs attention. Run ${COMMAND} doctor for details.`);
  }
  return { status: 'repaired', ready: true, backendRelease: report.release, checks };
}
