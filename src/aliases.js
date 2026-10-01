import path from 'node:path';
import { chmod, lstat, mkdir, readdir, open, unlink, writeFile } from 'node:fs/promises';
import { findOnPath } from 'veodl/src/backend.js';

export const BUILTINS = ['smolup', 'smush', 'smop', 'smup'];
const MARKER = 'smolup-managed-alias-v1';
export function aliasName(name) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name || '') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) {
    throw new Error('Alias names use 2–31 lowercase letters, digits or hyphens and start with a letter.');
  }
  return name;
}

export async function aliasDirectory(explicit) {
  if (explicit) return path.resolve(explicit);
  const command = await findOnPath(['smolup']);
  if (!command) throw new Error('Cannot find smolup on PATH. Run npm link or pass --bin-dir <directory>.');
  return path.dirname(command);
}

function aliasPaths(directory, name, platform) {
  aliasName(name);
  const files = platform === 'win32' ? [name, `${name}.cmd`, `${name}.ps1`] : [name];
  return files.map(file => {
    const absolute = path.resolve(directory, file);
    if (path.dirname(absolute) !== path.resolve(directory)) throw new Error('Alias path is outside the command directory.');
    return absolute;
  });
}

async function ownership(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return 'other';
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.toString('utf8', 0, bytesRead);
      return [MARKER, 'smop-managed-alias-v1', 'smup-managed-alias-v1'].some(marker => header.includes(marker)) ? 'managed' : 'other';
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}

export async function aliasCommand(args, { binDir, platform = process.platform } = {}) {
  const [action = 'list', name, ...extra] = args;
  if (extra.length) throw new Error('Use smolup alias list|add <name>|remove <name>.');
  const directory = await aliasDirectory(binDir);
  if (action === 'list') {
    if (name) throw new Error('Usage: smolup alias list');
    const names = new Set(BUILTINS);
    for (const entry of await readdir(directory)) {
      const candidate = entry.replace(/\.(?:cmd|ps1)$/, '');
      if (/^[a-z][a-z0-9-]{1,30}$/.test(candidate) && await ownership(path.join(directory, entry)) === 'managed') names.add(candidate);
    }
    const aliases = [];
    for (const value of [...names].sort()) {
      const files = aliasPaths(directory, value, platform);
      const states = await Promise.all(files.map(ownership));
      aliases.push({ name: value, builtin: BUILTINS.includes(value), present: states.some(s => s !== 'missing'),
        paths: files.filter((_, i) => states[i] !== 'missing') });
    }
    return { status: 'ok', binDir: directory, aliases };
  }
  aliasName(name);
  if (BUILTINS.includes(name)) throw new Error(`"${name}" is a built-in command and cannot be changed by alias management.`);
  const files = aliasPaths(directory, name, platform);
  const states = await Promise.all(files.map(ownership));
  if (action === 'add') {
    if (states.some(s => s !== 'missing')) throw new Error(`Command "${name}" already exists. It was not overwritten.`);
    // Check other executable extensions as well as our own wrapper files.
    for (const suffix of platform === 'win32' ? ['.exe', '.bat', '.com'] : []) {
      if (await ownership(path.join(directory, `${name}${suffix}`)) !== 'missing') throw new Error(`Command "${name}" already exists.`);
    }
    await mkdir(directory, { recursive: true });
    const wrappers = platform === 'win32' ? [
      `#!/bin/sh\n# ${MARKER}\nexec smolup "$@"\n`,
      `@echo off\r\nREM ${MARKER}\r\ncall smolup %*\r\nexit /b %errorlevel%\r\n`,
      `# ${MARKER}\nsmolup @args\nexit $LASTEXITCODE\n`,
    ] : [`#!/bin/sh\n# ${MARKER}\nexec smolup "$@"\n`];
    const created = [];
    try {
      for (let i = 0; i < files.length; i++) { await writeFile(files[i], wrappers[i], { flag: 'wx', mode: 0o755 }); created.push(files[i]); }
      if (platform !== 'win32') await chmod(files[0], 0o755);
    } catch (error) { for (const file of created) await unlink(file).catch(() => {}); throw error; }
    return { status: 'added', name, binDir: directory, paths: files };
  }
  if (['remove', 'rm'].includes(action)) {
    if (states.some(s => s === 'other')) throw new Error(`"${name}" contains files not managed by smolup. No files were removed.`);
    if (states.every(s => s === 'missing')) throw new Error(`Alias "${name}" does not exist.`);
    for (let i = 0; i < files.length; i++) if (states[i] === 'managed') await unlink(files[i]);
    return { status: 'removed', name, binDir: directory };
  }
  throw new Error('Use smolup alias list|add <name>|remove <name>.');
}
