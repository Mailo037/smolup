import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

export const environmentValue = (suffix, env = process.env) => env[`SMOLUP_${suffix}`] ?? env[`SMOP_${suffix}`] ?? env[`SMUP_${suffix}`];

function applicationDirectory(root) {
  const current = path.join(root, 'smolup');
  // Reuse existing data without copying cookies or splitting resumable history.
  return [current, path.join(root, 'smop'), path.join(root, 'smup')].find(existsSync) || current;
}

export function configDirectory() {
  const home = environmentValue('HOME');
  if (home) return path.resolve(home);
  const root = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return applicationDirectory(root);
}

export function stateDirectory() {
  if (environmentValue('HOME')) return path.join(configDirectory(), 'state');
  const root = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return applicationDirectory(root);
}

export const authFile = () => path.join(configDirectory(), 'auth.json');
export const jobsDirectory = () => path.join(stateDirectory(), 'jobs');
