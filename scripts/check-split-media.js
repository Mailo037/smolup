import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mediaTools, probe, downloadVideo, prepareVideo } from '../src/media.js';
import { prepareUploadJobs, loadUploadJobs } from '../src/split.js';
import { fingerprint } from '../src/uploader.js';
import { run } from '../src/process.js';

const directory = fileURLToPath(new URL('../.test-output/split-media/', import.meta.url));
await mkdir(directory, { recursive: true });
process.env.SMUP_HOME = path.join(directory, 'home');
const tools = await mediaTools();
const source = path.join(directory, 'synthetic-95s.mp4');
const generated = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=160x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '95', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source]);
assert.equal(generated.code, 0);
const originalHash = await fingerprint(source);
const result = await prepareUploadJobs(source, { start: 0, duration: 60, split: true, splitThreshold: 90,
  partLabel: 'prefix', visibility: 'private', rename: '{filename}', quality: 'best' }, { log: console.log, dependencies: { mediaTools: async () => tools } });
assert.equal(result.jobs.length, 2);
assert.equal(result.job.stage, 'prepared');
assert.equal((await loadUploadJobs(result.job)).length, 2);
assert.equal(result.jobs[0].metadata.title, 'Part 1 synthetic-95s');
assert.equal(result.jobs[1].metadata.title, 'Part 2 synthetic-95s');
assert.deepEqual(result.jobs.map(job => [job.clipStart, job.clipDuration]), [[0, 60], [60, 35]]);
for (const [index, job] of result.jobs.entries()) {
  const media = await probe(job.prepared, tools);
  assert.ok(media.duration <= 60 && media.duration > (index ? 34 : 59), `Unexpected clip duration: ${media.duration}`);
  assert.equal(media.video.codec_name, 'h264');
  assert.equal(media.audio.codec_name, 'aac');
}
assert.equal(await fingerprint(source), originalHash);
const fractional = await prepareVideo(source, path.join(directory, `fractional-${Date.now()}.mp4`), { tools, start: 4.2, duration: 20.57 });
assert.ok(fractional.duration > 20.5 && fractional.duration <= 20.57, `Fractional clip exceeded its duration: ${fractional.duration}`);
const bytes = await readFile(source);
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
  res.writeHead(range ? 206 : 200, headers);
  res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const downloadDirectory = path.join(directory, `full-download-${Date.now()}`);
  await mkdir(downloadDirectory, { recursive: true });
  const downloaded = await downloadVideo(`http://127.0.0.1:${server.address().port}/synthetic-95s.mp4`, downloadDirectory,
    { start: 5, duration: null, signal: AbortSignal.timeout(120000) });
  const full = await probe(downloaded, tools);
  assert.ok(full.duration >= 94.9, `Split URL source was truncated: ${full.duration}`);
  console.log(JSON.stringify({ status: 'passed', jobId: result.job.id, parts: result.jobs.map(job => ({ start: job.clipStart,
    duration: job.durationSeconds, sizeBytes: job.sizeBytes, title: job.metadata.title })), fractionalDuration: fractional.duration, fullDownloadDuration: full.duration }));
} finally { await new Promise(resolve => server.close(resolve)); }
