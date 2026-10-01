import os from 'node:os';
import path from 'node:path';

export function configDirectory() {
  if (process.env.SMUP_HOME) return path.resolve(process.env.SMUP_HOME);
  const root = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(root, 'smup');
}

export function stateDirectory() {
  if (process.env.SMUP_HOME) return path.join(configDirectory(), 'state');
  const root = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(root, 'smup');
}

export const authFile = () => path.join(configDirectory(), 'auth.json');
export const jobsDirectory = () => path.join(stateDirectory(), 'jobs');
