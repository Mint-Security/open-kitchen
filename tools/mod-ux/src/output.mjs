import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { execute } from './process.mjs';

// Resolve existing symlink parents even when the run directory does not exist.
async function outputLocation(directory) {
  let ancestor = resolve(directory);
  const missing = [];
  for (;;) {
    try { const existing = await realpath(ancestor); return { existing, directory: join(existing, ...missing) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** @param {import('./options.mjs').OutputOptions} [options] */
export async function assertPrivateOutput(directory, { allowUnignored = false } = {}) {
  if (allowUnignored) return;
  const location = await outputLocation(directory);
  const env = { ...process.env, LC_ALL: 'C' };
  let root;
  try { root = (await execute(['git', '-C', location.existing, 'rev-parse', '--show-toplevel'], { env })).stdout.trim(); }
  catch (error) {
    if (error.exitCode === 128 && error.stderr?.includes('not a git repository')) return;
    throw new Error(`Cannot check output Git visibility: ${error.message}. Use --allow-unignored-output only after reviewing the destination.`);
  }
  try { await execute(['git', '-C', root, 'check-ignore', '--quiet', '--no-index', '--', location.directory + sep], { env }); }
  catch (error) {
    if (error.exitCode !== 1) throw error;
    throw new Error('Output directory is inside a Git work tree and is not ignored. Use .mod-ux/, ignore the destination, or explicitly pass --allow-unignored-output. Captures may contain private screen content and typed text.');
  }
}
