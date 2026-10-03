import { terminalText } from 'veodl/src/progress.js';
import { cleanText } from 'veodl/src/utils.js';

const ANSI = {
  muted: '90', body: '39', title: '1', heading: '1;36', command: '36', flag: '33',
  value: '35', number: '94', profile: '39', success: '32', warning: '33', error: '31', prompt: '1;33',
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_SPINNER = ['|', '/', '-', '\\'];
const BAR_WIDTH = 20;
const NUMERIC = /^-?\d+(?:[.,]\d+)?(?:\s?(?:B|KiB|MiB|GiB|%|s))?$/;

export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, Number(bytes) || 0), unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// Keep indentation and newlines, while never trusting incoming terminal escapes.
function safeText(value) {
  return String(value).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

export function createTerminal({ json = false, color = true, forceColor = false, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const interactive = !json && Boolean(stderr.isTTY) && env.TERM !== 'dumb';
  const colors = stream => {
    if (json || color === false) return false;
    if (forceColor) return true;
    if (Object.hasOwn(env, 'NO_COLOR')) return false;
    if (Object.hasOwn(env, 'FORCE_COLOR')) return !['0', 'false'].includes(String(env.FORCE_COLOR).toLowerCase());
    return Boolean(stream.isTTY) && env.TERM !== 'dumb';
  };
  // Legacy Windows consoles lack braille glyphs; Windows Terminal and VS Code have them.
  const unicode = process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI);
  const spinner = unicode ? SPINNER : ASCII_SPINNER;
  let active, timer, frame = 0;
  // Sanitize before painting: cleaning generated ANSI would erase our colors.
  const paint = (stream, text, role = 'body') => colors(stream) && text ? `\x1b[${ANSI[role] || ANSI.body}m${text}\x1b[0m` : text;
  const styled = (stream, text, role = 'body') => paint(stream, safeText(text), role);
  const tokens = (stream, value, role = 'body') => {
    const text = safeText(value);
    const pattern = /--?[a-z][\w-]*\b|\{[a-z]+\}|<[^<>\n]+>|https?:\/\/[^\s]+|\b(?:smolup|smush|smop|smup)\b|\b\d+(?:\.\d+)*(?:%|s)?(?![\w.])/gi;
    let result = '', previous = 0;
    for (const match of text.matchAll(pattern)) {
      result += paint(stream, text.slice(previous, match.index), role);
      const token = match[0];
      const tokenRole = token.startsWith('-') ? 'flag' : /^[<{]/.test(token) ? 'value'
        : /^(?:smolup|smush|smop|smup)$/i.test(token) ? 'command' : 'number';
      result += paint(stream, token, tokenRole);
      previous = match.index + token.length;
    }
    return result + paint(stream, text.slice(previous), role);
  };
  const statusRole = (value, fallback = 'value') => {
    const text = cleanText(String(value)).toLowerCase();
    if (/^(?:done|ready|ok|pass|passed|yes|true|current|uploaded|public|installed|success)$/.test(text)) return 'success';
    if (/^(?:failed|error|false|no|missing|invalid)$/.test(text)) return 'error';
    if (/^(?:private|blocked|attention|unpublished|update-available|pending|waiting)$/.test(text)) return 'warning';
    if (/^-?\d+(?:\.\d+)?(?:\s|$)/.test(text)) return 'number';
    return fallback;
  };
  const clear = () => { if (interactive && active) stderr.write('\r\x1b[2K'); };
  const draw = () => {
    if (!interactive || !active) return;
    const width = Math.max(1, (stderr.columns || 80) - 1);
    const showBar = active.percent !== undefined && width >= 70;
    const segments = [
      [`${spinner[frame % spinner.length]} `, 'command'],
      [active.label, 'command'],
    ];
    if (showBar) {
      const filled = Math.round(active.percent / 100 * BAR_WIDTH);
      segments.push(['  ', 'muted'], ['█'.repeat(filled), 'command'], ['░'.repeat(BAR_WIDTH - filled), 'muted']);
    }
    segments.push([active.detail ? `  ${active.detail}` : '', 'tokens']);
    const plain = terminalText(stderr, segments.map(([text]) => text).join(''));
    let rest = plain, line = '';
    for (const [text, role] of segments) {
      const part = rest.slice(0, text.length);
      rest = rest.slice(part.length);
      line += role === 'tokens' ? tokens(stderr, part, 'muted') : styled(stderr, part, role);
    }
    stderr.write(`\r\x1b[2K${line}`);
  };
  const tick = () => { frame++; draw(); };
  const stop = () => { clearInterval(timer); timer = undefined; clear(); active = undefined; };
  const write = (stream, text) => { clear(); stream.write(`${text}\n`); draw(); };
  const output = (text, role = 'body') => write(stdout, tokens(stdout, text, role));
  return {
    output,
    label(label, value, role = 'value') {
      write(stdout, `${styled(stdout, `${label}:`, 'command')} ${styled(stdout, value, role === 'value' ? statusRole(value) : role)}`);
    },
    say(text) { write(stderr, tokens(stderr, text, 'muted')); },
    error(text) { stop(); stderr.write(`${styled(stderr, `smolup: ${text}`, 'error')}\n`); },
    prompt(text) { return styled(stderr, text, 'prompt'); },
    help(text) {
      const lines = safeText(text).trimEnd().split('\n');
      const formatted = lines.map((line, index) => {
        if (!line.trim()) return '';
        if (index === 0 && /—/.test(line) || !/^\s/.test(line) && /^[\w /-]+:$/.test(line)) return styled(stdout, line, 'heading');
        const command = /^(\s*)(?:smolup|smush|smop|smup)\b/.exec(line);
        if (command || /^\s+-[a-z-]/i.test(line)) {
          const indent = /^\s*/.exec(line)[0];
          const content = line.slice(indent.length);
          const separator = /\s{2,}(?=\S)/.exec(content);
          if (!separator) return indent + tokens(stdout, content, 'command');
          const syntax = content.slice(0, separator.index), description = content.slice(separator.index + separator[0].length);
          return indent + tokens(stdout, syntax, 'command') + separator[0] + tokens(stdout, description, 'muted');
        }
        return tokens(stdout, line, 'muted');
      });
      write(stdout, formatted.join('\n'));
    },
    async suspend(work) {
      const previous = active;
      stop();
      try { return await work(); }
      finally {
        if (previous) {
          active = previous;
          if (interactive) { draw(); timer = setInterval(tick, 100); timer.unref(); }
        }
      }
    },
    async step(label, work) {
      stop();
      active = { label: cleanText(label) };
      if (interactive) { draw(); timer = setInterval(tick, 100); timer.unref(); }
      else stderr.write(`${styled(stderr, `${active.label}…`, 'command')}\n`);
      try {
        const value = await work();
        stop();
        stderr.write(`${styled(stderr, `${label}:`, 'command')} ${styled(stderr, 'done', 'success')}\n`);
        return value;
      } catch (error) {
        stop();
        stderr.write(`${styled(stderr, `${label}:`, 'command')} ${styled(stderr, 'failed', 'error')}\n`);
        throw error;
      }
    },
    progress(bytes, total, timing) {
      if (!active) return;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor(bytes / total * 100))) : 0;
      active.percent = percent;
      const elapsed = Math.max(0.001, (Date.now() - timing.started) / 1000);
      const speed = Math.max(0, bytes - timing.initial) / elapsed;
      const eta = speed > 0 ? formatDuration((total - bytes) / speed) : '?';
      active.detail = `${percent}%  ${formatBytes(bytes)} / ${formatBytes(total)}  ${formatBytes(speed)}/s  ETA ${eta}`;
      if (interactive) draw();
      else if (percent === 100 || !timing.lastLog || Date.now() - timing.lastLog > 5000) {
        stderr.write(`${styled(stderr, `${active.label}:`, 'command')} ${tokens(stderr, active.detail, 'muted')}\n`); timing.lastLog = Date.now();
      }
    },
    download(line) {
      if (!active || !interactive) return;
      const text = cleanText(line);
      if (/\d+%|received; processing|^(?:Preparing|Checking|Loading|Processing)/i.test(text)) {
        const percent = /(\d+(?:\.\d+)?)%/.exec(text);
        if (percent) active.percent = Math.max(0, Math.min(100, Number(percent[1])));
        active.detail = text; draw();
      }
    },
    json(data) { clear(); stdout.write(`${JSON.stringify({ schemaVersion: 1, ...data })}\n`); draw(); },
    object(data) {
      const text = JSON.stringify(data, null, 2);
      if (text === undefined) return output('(undefined)', 'muted');
      const pattern = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
      let formatted = '', previous = 0;
      for (const match of text.matchAll(pattern)) {
        formatted += paint(stdout, text.slice(previous, match.index), 'muted');
        const token = match[0], key = token.startsWith('"') && /^\s*:/.test(text.slice(match.index + token.length));
        const role = key ? 'command' : token.startsWith('"') ? 'success' : token === 'null' ? 'muted'
          : /^(?:true|false)$/.test(token) ? 'flag' : 'number';
        formatted += paint(stdout, token, role);
        previous = match.index + token.length;
      }
      write(stdout, formatted + paint(stdout, text.slice(previous), 'muted'));
    },
    table(headers, rows) {
      const titles = headers.map(value => cleanText(String(value)));
      const values = rows.map(row => titles.map((_, i) => cleanText(String(row[i] ?? ''))));
      const widths = titles.map((title, i) => Math.min(i === titles.length - 1 ? 48 : 36, values.reduce((width, row) => Math.max(width, row[i].length), title.length)));
      const numeric = titles.map((_, i) => values.some(row => row[i]) && values.every(row => !row[i] || NUMERIC.test(row[i])));
      const render = (row, heading) => row.map((value, i) => {
        const fitted = value.length > widths[i] ? `${value.slice(0, widths[i] - 1)}…` : value;
        const role = heading ? 'heading' : statusRole(value, i === 0 ? 'command' : i % 2 ? 'value' : 'profile');
        const padding = ' '.repeat(Math.max(0, widths[i] - fitted.length));
        if (numeric[i]) return padding + styled(stdout, fitted, role);
        return styled(stdout, fitted, role) + (i === row.length - 1 ? '' : padding);
      }).join('  ');
      write(stdout, render(titles, true));
      write(stdout, paint(stdout, widths.map(width => '─'.repeat(width)).join('  '), 'muted'));
      for (const row of values) write(stdout, render(row, false));
    },
    close() { stop(); },
  };
}
