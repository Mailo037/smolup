import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { authFile, configDirectory } from './paths.js';
import { run, windowsPowerShellEnv } from './process.js';

export function normalizeCookie(input) {
  const value = input.trim().replace(/^cookie:\s*/i, '');
  if (!value || /[\r\n\0]/.test(value) || !value.includes('=')) {
    throw new Error('Use the complete smolish.com Cookie header (name=value; name=value).');
  }
  return value;
}

export async function loadAuth() {
  const inline = process.env.SMUP_COOKIE;
  const cookieFile = process.env.SMUP_COOKIE_FILE;
  if (inline) return { cookie: normalizeCookie(inline) };
  if (cookieFile) {
    return { cookie: normalizeCookie(await readFile(cookieFile, 'utf8')) };
  }
  let saved;
  try { saved = JSON.parse(await readFile(authFile(), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('No cookie configured. Run smup setup first.');
    throw new Error('Cannot read the saved cookie. Run smup setup again.');
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Cannot read the saved cookie. Run smup setup again.');
  if (saved.protection === 'windows-dpapi') {
    if (typeof saved.encrypted !== 'string' || !/^[a-f0-9]+$/i.test(saved.encrypted)) throw new Error('Cannot read the encrypted cookie. Run smup setup again.');
    if (process.platform !== 'win32') throw new Error('This cookie is bound to a Windows user. Run smup setup on this device.');
    const result = await run('powershell.exe', ['-NoProfile', '-Command',
      '$ErrorActionPreference="Stop"; $encoded=([Console]::In.ReadToEnd()).Trim(); $secret=ConvertTo-SecureString $encoded; [Console]::Out.Write(([System.Net.NetworkCredential]::new("",$secret)).Password)'],
    { input: saved.encrypted, env: windowsPowerShellEnv() });
    if (result.code !== 0) throw new Error('Cannot decrypt the saved cookie. Run smup setup again.');
    return { cookie: normalizeCookie(result.stdout) };
  }
  if (saved.protection !== 'file') throw new Error('Unknown cookie format. Run smup setup again.');
  if (typeof saved.cookie !== 'string') throw new Error('Cannot read the saved cookie. Run smup setup again.');
  return { cookie: normalizeCookie(saved.cookie) };
}

export async function saveAuth(input) {
  const cookie = normalizeCookie(input);
  let record;
  if (process.platform === 'win32') {
    const encrypted = await run('powershell.exe', ['-NoProfile', '-Command',
      '$ErrorActionPreference="Stop"; $smupValue=[Console]::In.ReadToEnd(); $smupSecret=ConvertTo-SecureString $smupValue -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $smupSecret))'],
    { input: cookie, env: windowsPowerShellEnv() });
    if (encrypted.code !== 0 || !/^[a-f0-9]+$/i.test(encrypted.stdout.trim())) throw new Error('Cannot encrypt the cookie for this Windows user.');
    record = { protection: 'windows-dpapi', encrypted: encrypted.stdout.trim() };
  } else record = { protection: 'file', cookie };
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${authFile()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, authFile());
    if (process.platform !== 'win32') await chmod(authFile(), 0o600);
  } finally { await rm(temporary, { force: true }); }
  return authFile();
}

async function hiddenInput(label, signal) {
  signal?.throwIfAborted();
  if (!process.stdin.isTTY) throw new Error('Setup requires an interactive terminal. Set SMUP_COOKIE_FILE for non-interactive use.');
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => finish(new DOMException('Setup cancelled.', 'AbortError'));
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') return onAbort();
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function setupAuth({ color = true, forceColor = false, signal, prompt } = {}) {
  signal?.throwIfAborted();
  if (!process.stdin.isTTY) throw new Error('Setup requires an interactive terminal. Set SMUP_COOKIE_FILE for non-interactive use.');
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const script = await readFile(fileURLToPath(new URL('../scripts/setup-windows.ps1', import.meta.url)), 'utf8');
    const code = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        shell: false, signal, env: windowsPowerShellEnv({ SMUP_AUTH_DESTINATION: authFile(),
          SMUP_SETUP_COLOR: color && (forceColor || !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb') ? '1' : '0' }), stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error('Cookie setup did not finish.');
  } else {
    const cookie = await hiddenInput(prompt || 'Smolish Cookie header (input hidden): ', signal);
    await saveAuth(cookie);
  }
  return authFile();
}
