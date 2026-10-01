import { createInterface } from 'node:readline/promises';

export const STORAGE_URL = 'https://smolish.com/storage/apply';
export const REFERENCE_TIERS = [
  { tier: 'new', label: 'New account', quotaBytes: 1024 ** 3, dailyVideoLimit: 1024 ** 3 },
  { tier: 'standard', label: 'Standard', quotaBytes: 6 * 1024 ** 3, dailyVideoLimit: 2 * 1024 ** 3 },
  { tier: 'trusted', label: 'Trusted', quotaBytes: 40 * 1024 ** 3, dailyVideoLimit: 10 * 1024 ** 3 },
];
const counter = (data, key) => {
  if (!Number.isSafeInteger(data[key]) || data[key] < 0) throw new Error(`Storage data is missing a valid ${key} counter.`);
  return data[key];
};

export function normalizeStorage(data) {
  if (!data || typeof data.tier !== 'string' || !data.tier) throw new Error('Storage data is missing the account tier.');
  const quotaBytes = counter(data, 'quotaBytes'), usedBytes = counter(data, 'usedBytes');
  const dailyVideoLimit = counter(data, 'dailyVideoLimit'), dailyVideoBytes = counter(data, 'dailyVideoBytes');
  return { tier: data.tier, label: REFERENCE_TIERS.find(t => t.tier === data.tier)?.label || data.tier,
    quotaBytes, usedBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes),
    dailyVideoLimit, dailyVideoBytes, dailyRemainingBytes: Math.max(0, dailyVideoLimit - dailyVideoBytes),
    overQuota: usedBytes > quotaBytes, source: STORAGE_URL, fetchedAt: new Date().toISOString() };
}

function objectEnding(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

export function storageFromPage(html) {
  if (typeof html !== 'string' || html.length > 10 * 1024 * 1024) throw new Error('Invalid storage page response.');
  const payloads = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = match[1];
    const flight = script.match(/self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/);
    if (flight) {
      try { const chunk = JSON.parse(flight[1]); if (chunk[0] === 1 && typeof chunk[1] === 'string') payloads.push(chunk[1]); }
      catch { /* Unrecognized scripts are never executed. */ }
    } else if (script.trimStart().startsWith('{')) payloads.push(script);
  }
  // Flight can divide a JSON object across several script blocks.
  const text = payloads.join('');
  for (const match of text.matchAll(/"quotaBytes"\s*:/g)) {
    const start = text.lastIndexOf('{', match.index);
    if (start < 0) continue;
    const end = objectEnding(text, start);
    if (end < 0) continue;
    try { return normalizeStorage(JSON.parse(text.slice(start, end))); }
    catch { /* Keep looking for the account storage object. */ }
  }
  throw new Error('Account storage counters were not found. Check Smolish sign-in or a website update.');
}

export async function readStorage(api) { return storageFromPage(await api.storagePage()); }
export function formatSize(bytes) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }

export function evaluateQuota(storage, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid proposed upload size.');
  const reasons = [];
  if (bytes > storage.remainingBytes) reasons.push(`Storage: ${formatSize(bytes)} needed, ${formatSize(storage.remainingBytes)} available.`);
  if (bytes > storage.dailyRemainingBytes) reasons.push(`Daily uploads: ${formatSize(bytes)} needed, ${formatSize(storage.dailyRemainingBytes)} available.`);
  return { allowed: reasons.length === 0, proposedBytes: bytes, reasons, storage };
}

export class QuotaError extends Error {
  constructor(message, quota) { super(message); this.quota = quota; this.code = 'QUOTA_CHECK'; }
}

export async function askYesNo(question, signal) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await rl.question(question, { signal })).trim()); }
  finally { rl.close(); }
}

export async function quotaPreflight(api, jobs, { tryAnyway = false, interactive = false, confirm, log = () => {}, signal } = {}) {
  const pending = jobs.filter(j => j.stage !== 'done' && !j.videoId);
  if (!pending.length) return { allowed: true, proposedBytes: 0, reasons: [], skipped: 'Existing drafts are resumed under server limits' };
  const bytes = pending.reduce((sum, j) => sum + j.sizeBytes, 0);
  let quota;
  try { quota = evaluateQuota(await readStorage(api), bytes); }
  catch (error) {
    signal?.throwIfAborted();
    quota = { allowed: false, proposedBytes: bytes, reasons: [`Could not verify account limits: ${error.message}`], storage: null, unavailable: true };
  }
  if (quota.allowed) return quota;
  for (const reason of quota.reasons) log(reason);
  if (tryAnyway) { log('Attempting the normal upload API once; Smolish still enforces its limits.'); return { ...quota, overridden: true }; }
  if (interactive) {
    const prompt = confirm || (question => askYesNo(question, signal));
    if (await prompt('This upload may exceed account limits. Try anyway? [y/N] ')) return { ...quota, overridden: true };
  }
  throw new QuotaError('Upload stopped by the storage check. Use --try-anyway for an explicit attempt, or free storage and resume later.', quota);
}
