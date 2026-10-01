export const VISIBILITIES = ['private', 'public', 'unlisted'];
export const QUALITY_PATTERN = /^(?:best|[1-9]\d{1,3}p)$/;
export const DEFAULTS = Object.freeze({ visibility: 'private', rename: ' ', start: 0, duration: 60, quality: 'best', color: true,
  split: false, splitThreshold: 90, partLabel: 'prefix' });
export const SETTING_KEYS = [...Object.keys(DEFAULTS), 'description', 'output'];

export function validateSetting(key, value) {
  if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown setting "${key}". Available: ${SETTING_KEYS.join(', ')}.`);
  if (key === 'visibility' && !VISIBILITIES.includes(value)) throw new Error('Visibility must be private, public or unlisted.');
  if (key === 'rename' && (typeof value !== 'string' || value.length > 100 || /[\r\n\0]/.test(value))) throw new Error('The title must be at most 100 characters on one line.');
  if (key === 'description' && (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))) throw new Error('The description must be at most 2,000 characters.');
  if (key === 'start' && (!Number.isFinite(value) || value < 0)) throw new Error('Start must be a number greater than or equal to 0.');
  if (key === 'duration' && (!Number.isFinite(value) || value <= 0 || value > 60)) throw new Error('Duration must be greater than 0 and at most 60 seconds.');
  if (key === 'quality' && (typeof value !== 'string' || !QUALITY_PATTERN.test(value))) throw new Error('Quality must be best or a resolution such as 720p.');
  if (key === 'color' && typeof value !== 'boolean') throw new Error('Color must be true or false.');
  if (key === 'split' && typeof value !== 'boolean') throw new Error('Split must be true or false.');
  if (key === 'splitThreshold' && (!Number.isFinite(value) || value < 60)) throw new Error('Split threshold must be at least 60 seconds.');
  if (key === 'partLabel' && !['prefix', 'suffix', 'none'].includes(value)) throw new Error('Part label must be prefix, suffix or none.');
  if (key === 'output' && (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value))) throw new Error('Output must be a non-empty directory path.');
  return value;
}

export function settingValue(key, text) {
  const value = ['start', 'duration', 'splitThreshold'].includes(key) ? (text.trim() ? Number(text) : NaN)
    : ['color', 'split'].includes(key) ? text === 'true' ? true : text === 'false' ? false : text : text;
  return validateSetting(key, value);
}

export function validateSettings(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Settings must be a JSON object.');
  for (const [key, value] of Object.entries(object)) validateSetting(key, value);
  return { ...object };
}

export function metadataFromSettings(settings) {
  const data = { title: validateSetting('rename', settings.rename ?? DEFAULTS.rename),
    visibility: validateSetting('visibility', settings.visibility ?? DEFAULTS.visibility) };
  if (settings.description !== undefined) data.description = validateSetting('description', settings.description);
  return data;
}

export function metadataOverrides(settings) {
  const data = {};
  if (settings.rename !== undefined) data.title = validateSetting('rename', settings.rename);
  if (settings.visibility !== undefined) data.visibility = validateSetting('visibility', settings.visibility);
  if (settings.description !== undefined) data.description = validateSetting('description', settings.description);
  return data;
}
