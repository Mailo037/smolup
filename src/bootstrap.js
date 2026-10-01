import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PACKAGE_NAME, VERSION, COMMAND } from './identity.js';
import { run } from './process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const hasVeo = () => {
  try { require.resolve('veodl/src/backend.js'); return true; }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') return false; throw error; }
};

export async function repairDependency(signal) {
  const { npmInvocation } = await import('./maintenance.js');
  const npm = await npmInvocation();
  const env = { ...process.env };
  // npm run/npx can forward persistent script policy as a rejected env override.
  // This repair blocks every lifecycle script explicitly with --ignore-scripts.
  for (const key of Object.keys(env)) if (/^(?:smop|smup)_cookie(?:_file)?$|^npm_config_allow_scripts$/i.test(key)) delete env[key];
  const result = await run(npm.file, [...npm.args, 'install', '--global=false', '--prefix', root, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { signal, env });
  if (result.code !== 0) throw new Error('VEO dependency installation failed. Run npm install in the smop installation directory, then retry smop doctorfix.');
}

export async function launch(args = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const env = dependencies.env || process.env;
  const json = args.includes('--json');
  const paint = (text, code = 36) => !json && !args.includes('--no-color')
    && (args.includes('--color') || stderr.isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb')
    ? `\x1b[${code}m${text}\x1b[0m` : text;
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Cancelled.'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    if (!(await (dependencies.hasVeo || hasVeo)())) {
      if (args.some(arg => ['--version', '-v'].includes(arg))) {
        stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: 'version', status: 'ok', version: VERSION })}\n` : `${paint(`${COMMAND} ${VERSION}`)}\n`);
        return 0;
      }
      if (!args.length || args.some(arg => ['--help', '-h'].includes(arg)) || args[0] === 'help') {
        const { HELP, COMMAND_HELP } = await import('./help.js');
        const text = COMMAND_HELP[args[0] === 'help' ? args[1] : args[0]] || HELP;
        stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: 'help', status: 'ok', text })}\n` : `${paint(text.trimEnd())}\n`);
        return 0;
      }
      const repair = args[0] === 'doctorfix' || args[0] === 'doctor' && args[1] === 'fix';
      const extra = args.slice(args[1] === 'fix' ? 2 : 1);
      if (!repair || extra.some(arg => !['--json', '--color', '--no-color', '--online'].includes(arg)) || args.includes('--color') && args.includes('--no-color')) {
        throw new Error('The VEO dependency is missing. Run smop doctorfix to install it.');
      }
      stderr.write(`${paint('Installing the pinned VEO dependency…')}\n`);
      await (dependencies.repair || repairDependency)(controller.signal);
      if (!(await (dependencies.hasVeo || hasVeo)())) throw new Error(`VEO is still unavailable. Reinstall ${COMMAND} with npm install --global ${PACKAGE_NAME}@latest.`);
      stderr.write(`${paint('VEO dependency installed.', 32)}\n`);
    }
    // Drop the bootstrap signal handlers before main owns cancellation.
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    const module = await (dependencies.load || (() => import('./cli.js')))();
    return await module.main(args, { stdout, stderr });
  } catch (error) {
    const message = controller.signal.aborted ? 'Cancelled.' : error.message;
    stderr.write(`${paint(`smop: ${message}`, 31)}\n`);
    if (json) stdout.write(`${JSON.stringify({ schemaVersion: 1, command: args[0] || null, status: 'failed', error: message })}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}
