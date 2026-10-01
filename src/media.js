import path from 'node:path';
import { createRequire } from 'node:module';
import { copyFile, stat, writeFile } from 'node:fs/promises';
import { resolveMediaTools, backendCacheDirectory } from 'veodl/src/backend.js';
import { run } from './process.js';
import { MAX_BYTES } from './api.js';
import { validateSetting } from './settings.js';

const require = createRequire(import.meta.url);
export const veoBin = () => require.resolve('veodl/bin/veo.js');

export async function mediaTools(signal) {
  const directory = await resolveMediaTools({ directory: backendCacheDirectory(), signal });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return { ffmpeg: path.join(directory, `ffmpeg${suffix}`), ffprobe: path.join(directory, `ffprobe${suffix}`) };
}

export async function probe(file, tools, signal) {
  const result = await run(tools.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal });
  if (result.code !== 0) throw new Error('FFprobe could not read the video.');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('FFprobe returned invalid JSON.'); }
  const streams = data.streams || [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === 'audio');
  const duration = Math.max(0, ...[data.format?.duration, video?.duration, audio?.duration].map(Number).filter(Number.isFinite));
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('The file does not contain a readable video with a known duration.');
  return { duration, video, audio, sizeBytes: (await stat(file)).size, format: data.format?.format_name || '' };
}

export async function downloadVideo(url, directory, { start = 0, duration = 60, quality = 'best', signal, log = () => {}, onDownloadLine } = {}) {
  validateSetting('start', start);
  if (duration !== null) validateSetting('duration', duration);
  validateSetting('quality', quality);
  // Do not inherit unrelated VEO defaults, profiles or source-site credentials.
  const isolatedConfig = path.join(directory, 'veo-config.json');
  await writeFile(isolatedConfig, '{}');
  const args = [veoBin(), url, '--json', '--incognito', '--compatible', '--format', 'mp4',
    '--no-audio', '--no-playlist', '--no-open', '--no-subs', '--no-auto-subs',
    '--no-embed-subs', '--no-embed-thumbnail', '--no-embed-metadata', '--no-resume', '--no-skip-existing',
    '--no-color', '--quality', quality, '--output', directory];
  // Split uploads need the entire source. The caller applies the start offset
  // locally after probing rather than requesting an unreliable open-ended cut.
  if (duration !== null) args.push('--section', `*${start}-${start + duration}`);
  log('Downloading video with VEO…');
  let pending = '';
  const downloaderEnv = { ...process.env, VEO_NO_UPDATE_CHECK: '1', VEO_CONFIG: isolatedConfig };
  for (const key of Object.keys(downloaderEnv)) if (/^(?:smop|smup)_cookie(?:_file)?$/i.test(key)) delete downloaderEnv[key];
  const result = await run(process.execPath, args, { signal, env: downloaderEnv,
    onStderr: chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onDownloadLine?.(line);
    } });
  let outputs;
  try { outputs = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error('VEO did not return valid download JSON.'); }
  const output = outputs[0];
  if (result.code !== 0 || outputs.length !== 1 || output?.status !== 'saved' || output.files?.length !== 1) {
    const reason = String(output?.error || result.stderr.split(/\r?\n/).filter(Boolean).at(-1) || '')
      .replace(/https?:\/\/\S+/g, '[URL]').slice(0, 600);
    throw new Error(`VEO download failed${result.code !== null ? ` (exit ${result.code})` : ''}.${reason ? ` ${reason}` : ''}`);
  }
  return path.resolve(output.files[0]);
}

export async function prepareVideo(input, output, { start = 0, duration: maxDuration = 60, signal, tools, log = () => {} } = {}) {
  validateSetting('start', start);
  validateSetting('duration', maxDuration);
  tools ||= await mediaTools(signal);
  const source = await probe(input, tools, signal);
  if (start >= source.duration) throw new Error('The start position is beyond the end of the video.');
  // Keep split boundaries contiguous. MP4 duration uses milliseconds, and the
  // frame cap below prevents a partial final frame from exceeding that bound.
  const duration = Math.floor(Math.min(source.duration - start, maxDuration) * 1000) / 1000;
  if (duration <= 0) throw new Error('The requested clip is too short to prepare.');
  const compatible = source.video.codec_name === 'h264' && source.video.pix_fmt === 'yuv420p'
    && (!source.audio || source.audio.codec_name === 'aac') && source.format.includes('mp4');
  if (compatible && start === 0 && source.duration <= maxDuration && source.sizeBytes <= MAX_BYTES) {
    await copyFile(input, output);
  } else {
    if (/smpte2084|arib-std-b67/.test(source.video.color_transfer || '')) {
      throw new Error('HDR video needs an explicit color conversion. Prepare an SDR version first.');
    }
    log(`Preparing video (${duration.toFixed(1)} seconds)…`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', String(start), '-i', input,
      '-t', String(duration), '-map', `0:${source.video.index}`, ...(source.audio ? ['-map', `0:${source.audio.index}`] : []), '-sn', '-dn',
      '-vf', 'scale=max(2\\,trunc(iw/2)*2):max(2\\,trunc(ih/2)*2),fps=30,format=yuv420p',
      '-frames:v', String(Math.max(1, Math.floor(duration * 30 + 1e-7))),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', '30M', '-bufsize', '60M',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-map_metadata', '-1', output];
    const result = await run(tools.ffmpeg, args, { signal });
    if (result.code !== 0) throw new Error('FFmpeg could not prepare the video.');
  }
  const prepared = await probe(output, tools, signal);
  if (prepared.duration > maxDuration) throw new Error(`Prepared video is ${prepared.duration.toFixed(3)} seconds long; upload stopped.`);
  if (prepared.sizeBytes > MAX_BYTES) throw new Error('Prepared video exceeds 300 MiB; upload stopped.');
  return { ...prepared, inputDuration: source.duration, trimmed: start > 0 || source.duration > maxDuration };
}
