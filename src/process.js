import { spawn } from 'node:child_process';

export function windowsPowerShellEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // PowerShell 7 module paths cannot be inherited by Windows PowerShell 5.1.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

export function run(file, args, { signal, input, env, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...(env || process.env) };
    for (const key of Object.keys(childEnv)) {
      if (/^(?:smolup|smop|smup)_cookie(?:_file)?$/i.test(key)) delete childEnv[key];
    }
    const child = spawn(file, args, {
      shell: false, windowsHide: true, signal, env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        child.kill();
        reject(new Error('The media program produced too much output.'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-16000);
      onStderr?.(String(chunk));
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
