import { spawn } from 'node:child_process';
import { assert } from './protocol.mjs';

export function commandArray(value) {
  const command = typeof value === 'string' ? JSON.parse(value) : value;
  assert(Array.isArray(command) && command.length > 0 && command.every(part => typeof part === 'string' && !part.includes('\0')), 'Command must be a JSON array of strings');
  assert(command[0].length > 0, 'Command executable is empty');
  return command;
}

// Never invoke a shell. Timeout/abort kills the process group and bounds pipe cleanup.
/** @param {import('./options.mjs').ProcessOptions} [options] */
export function execute(command, { input = '', timeoutMs = 30000, cwd, env = process.env, signal, maxBytes = 16 * 1024 * 1024, onStdout } = {}) {
  commandArray(command);
  if (signal?.aborted) return Promise.reject(new Error('Process aborted'));
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [], stderrChunks = [];
    let bytes = 0, failure, settled = false;
    let killTimer;
    const kill = () => {
      try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
        // An escaped descendant can retain these pipes after the child exits.
        // Bound cancellation independently of the streams' close event.
        settle(failure);
      }, 500);
    };
    const fail = error => { if (!failure) { failure = error; kill(); } };
    const abort = () => fail(new Error('Process aborted'));
    const timer = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = () => {
      // The parent can exit before a descendant that ignores SIGTERM.
      if (failure && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      finish();
      if (error) {
        // Whatever the process wrote before it was stopped, for evidence.
        error.stdout ??= Buffer.concat(stdoutChunks).toString('utf8');
        error.stderr ??= Buffer.concat(stderrChunks).toString('utf8');
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        child.unref();
        reject(error);
      } else resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(new Error('Process output limit exceeded')); return; }
      stdoutChunks.push(chunk);
      try { onStdout?.(chunk); } catch (error) { fail(error); }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) fail(new Error('Process output limit exceeded')); else stderrChunks.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', error => settle(error));
    child.on('close', (code, killedBy) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (failure) settle(failure);
      else if (code !== 0) {
        const error = new Error(`${command[0]} exited ${code ?? killedBy}: ${stderr.slice(-2000)}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        settle(error);
      } else settle(null, { stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function parseJSON(output) {
  try { return JSON.parse(output); } catch { throw new Error('Command did not return one valid JSON document'); }
}
