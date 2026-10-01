import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaTools, prepareVideo, downloadVideo } from '../src/media.js';
import { run } from '../src/process.js';

const directory = fileURLToPath(new URL('../.test-output/media/', import.meta.url));
await mkdir(directory, { recursive: true });
const tools = await mediaTools();
const source = path.join(directory, 'synthetic-65s.mp4');
const generated = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=160x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '65', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
assert.equal(generated.code, 0);
const clippedFile = path.join(directory, 'clipped.mp4');
await rm(clippedFile, { force: true });
const clipped = await prepareVideo(source, clippedFile, { tools, log: console.log });
assert.ok(clipped.duration > 59 && clipped.duration <= 60, `duration=${clipped.duration}`);
assert.equal(clipped.video.codec_name, 'h264');
assert.equal(clipped.audio.codec_name, 'aac');
const offsetFile = path.join(directory, 'offset.mp4');
await rm(offsetFile, { force: true });
const offset = await prepareVideo(source, offsetFile, { tools, start: 62 });
assert.ok(offset.duration >= 2.9 && offset.duration <= 3.1);
const shortFile = path.join(directory, 'short.mp4');
await rm(shortFile, { force: true });
const short = await prepareVideo(source, shortFile, { tools, start: 5, duration: 20 });
assert.ok(short.duration > 19 && short.duration <= 20, `duration=${short.duration}`);
const sourceBytes = await readFile(source);
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), sourceBytes.length - 1) : sourceBytes.length - 1;
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${sourceBytes.length}`;
  res.writeHead(range ? 206 : 200, headers);
  res.end(req.method === 'HEAD' ? undefined : sourceBytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const downloadDirectory = path.join(directory, 'download');
  await mkdir(downloadDirectory, { recursive: true });
  const downloaded = await downloadVideo(`http://127.0.0.1:${server.address().port}/synthetic-65s.mp4`, downloadDirectory, { log: console.log, start: 5, duration: 20, quality: '720p' });
  const finalFile = path.join(directory, 'download-prepared.mp4');
  await rm(finalFile, { force: true });
  const final = await prepareVideo(downloaded, finalFile, { tools, duration: 20 });
  assert.ok(final.duration > 19 && final.duration <= 20);
  console.log(JSON.stringify({ status: 'passed', trimDuration: clipped.duration, offsetDuration: offset.duration, presetDuration: short.duration, veoDownloadDuration: final.duration }));
} finally { await new Promise(resolve => server.close(resolve)); }
