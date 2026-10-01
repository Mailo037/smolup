import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { configDirectory } from './paths.js';
import { DEFAULTS, validateSettings, validateSetting, settingValue } from './settings.js';

export const configFile = () => process.env.SMUP_CONFIG ? path.resolve(process.env.SMUP_CONFIG) : path.join(configDirectory(), 'config.json');
export const emptyConfig = () => ({ version: 1, defaults: {}, presets: {}, activePreset: null });
const reserved = ['list', 'show', 'add', 'remove', 'rm', 'use', 'reset', 'none'];

export function presetName(name) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name || '') || reserved.includes(name)) {
    throw new Error('Preset names use 1–31 lowercase letters, digits or hyphens and start with a letter. Command names are reserved.');
  }
  return name;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1) throw new Error('Config must be an object with version: 1.');
  for (const key of Object.keys(config)) if (!['version', 'defaults', 'presets', 'activePreset'].includes(key)) throw new Error(`Unknown config key "${key}".`);
  validateSettings(config.defaults);
  if (!config.presets || typeof config.presets !== 'object' || Array.isArray(config.presets)) throw new Error('Presets must be a JSON object.');
  for (const [name, settings] of Object.entries(config.presets)) { presetName(name); validateSettings(settings); }
  if (config.activePreset !== null && (!config.activePreset || !Object.hasOwn(config.presets, config.activePreset))) throw new Error('The active preset does not exist.');
  return config;
}

export async function loadConfig(file = configFile()) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return emptyConfig(); throw new Error(`Cannot read config: ${file}`); }
  let config;
  try { config = JSON.parse(text); } catch { throw new Error(`Config is not valid JSON: ${file}`); }
  return validateConfig(config);
}

export async function saveConfig(config, file = configFile()) {
  validateConfig(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function resolveSettings(config, overrides = {}, selected) {
  const name = selected === 'none' ? null : selected || config.activePreset;
  if (name && !Object.hasOwn(config.presets, name)) throw new Error(`Unknown preset "${name}". Run smup preset list.`);
  return { ...DEFAULTS, ...config.defaults, ...(name ? config.presets[name] : {}), ...validateSettings(overrides), preset: name };
}

export async function configCommand(args, { preset } = {}) {
  const [action = 'show', key, value, ...extra] = args;
  if (extra.length) throw new Error('Usage: smup config set <setting> <value>');
  if (action === 'path') {
    if (key) throw new Error('Usage: smup config path');
    return { status: 'ok', file: configFile() };
  }
  if (action === 'reset') {
    if (key) throw new Error('Usage: smup config reset');
    await saveConfig(emptyConfig());
    return { status: 'reset', file: configFile(), config: emptyConfig() };
  }
  const config = await loadConfig();
  if (['show', 'check'].includes(action)) {
    if (key) throw new Error(`Usage: smup config ${action}`);
    return { status: action === 'check' ? 'valid' : 'ok', file: configFile(), config, effective: resolveSettings(config, {}, preset) };
  }
  if (action === 'set') {
    if (!key || value === undefined) throw new Error('Usage: smup config set <setting> <value>');
    config.defaults[key] = settingValue(key, value);
  } else if (['unset', 'remove'].includes(action)) {
    if (!key || value !== undefined) throw new Error('Usage: smup config unset <setting>');
    // Validate the name even when no custom value is present.
    validateSetting(key, config.defaults[key] ?? DEFAULTS[key] ?? (key === 'output' ? '.' : ''));
    delete config.defaults[key];
  } else if (action === 'edit') {
    if (key) throw new Error('Usage: smup config edit');
    await saveConfig(config);
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad.exe' : 'nano');
    const command = [...editor.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)].map(m => m[1] || m[2] || m[3]);
    if (!command.length) throw new Error('Set EDITOR to a valid editor command.');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command[0], [...command.slice(1), configFile()], { shell: false, stdio: 'inherit' });
      child.once('error', reject); child.once('close', resolve);
    });
    if (code !== 0) throw new Error('The config editor did not finish successfully.');
    return { status: 'valid', file: configFile(), config: await loadConfig() };
  } else throw new Error('Use smup config show|set|unset|path|edit|check|reset.');
  await saveConfig(config);
  return { status: action === 'set' ? 'updated' : 'removed', file: configFile(), config, effective: resolveSettings(config) };
}

export async function presetCommand(args, overrides = {}) {
  const [action = 'list', name, ...extra] = args;
  if (extra.length) throw new Error('Use smup preset list|show|add|remove|use|reset.');
  const config = await loadConfig();
  if (action === 'list') {
    if (name) throw new Error('Usage: smup preset list');
    return { status: 'ok', activePreset: config.activePreset, presets: config.presets };
  }
  if (action === 'reset') {
    if (name) throw new Error('Usage: smup preset reset');
    config.activePreset = null;
  } else {
    presetName(name);
    if (action === 'add') {
      if (Object.hasOwn(config.presets, name)) throw new Error(`Preset "${name}" already exists. Remove it first to replace it.`);
      config.presets[name] = validateSettings(overrides);
    } else {
      if (!Object.hasOwn(config.presets, name)) throw new Error(`Preset "${name}" does not exist.`);
      if (action === 'show') return { status: 'ok', name, settings: config.presets[name], effective: resolveSettings(config, {}, name) };
      if (['remove', 'rm'].includes(action)) { delete config.presets[name]; if (config.activePreset === name) config.activePreset = null; }
      else if (action === 'use') config.activePreset = name;
      else throw new Error('Use smup preset list|show|add|remove|use|reset.');
    }
  }
  await saveConfig(config);
  return { status: action === 'add' ? 'added' : ['remove', 'rm'].includes(action) ? 'removed' : 'updated', name: name || null,
    activePreset: config.activePreset, presets: config.presets };
}
