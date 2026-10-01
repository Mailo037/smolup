import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

export async function exportVideo(file, directory, filename) {
  const target = path.resolve(directory);
  await mkdir(target, { recursive: true });
  let base = path.parse(path.basename(filename)).name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 160) || 'video';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `video-${base}`;
  for (let index = 0; index < 10000; index++) {
    const output = path.join(target, `${base}${index ? ` (${index + 1})` : ''}.mp4`);
    try { await copyFile(file, output, constants.COPYFILE_EXCL); return output; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Cannot find an unused output filename.');
}
