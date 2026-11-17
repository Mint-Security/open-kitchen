import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/process.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('subprocess JSON preserves UTF-8 split across stdout chunks', async () => {
  const output = await execute([process.execPath, '-e', 'process.stdout.write(Buffer.from([0x22,0xe2]));setTimeout(()=>process.stdout.end(Buffer.from([0x82,0xac,0x22])),50)']);
  assert.equal(JSON.parse(output.stdout), '€');
});

test('failed subprocesses preserve split UTF-8 in stdout and stderr', async () => {
  const child = 'process.stdout.write(Buffer.from([0xe2]));process.stderr.write(Buffer.from([0xe2]));setTimeout(()=>{process.stdout.end(Buffer.from([0x82,0xac]));process.stderr.end(Buffer.from([0x82,0xac]));process.exitCode=3;},50)';
  await assert.rejects(execute([process.execPath, '-e', child]), error => {
    assert.equal(error.stdout, '€');
    assert.match(error.message, /exited 3: €/);
    assert(!error.message.includes('\uFFFD'));
    return true;
  });
});

test('output is streamed as it comes, and a stopped process keeps what it wrote', async () => {
  const chunks = [];
  const streamed = await execute([process.execPath, '-e', 'process.stdout.write("a");setTimeout(()=>process.stdout.write("b"),30)'], { onStdout: chunk => chunks.push(String(chunk)) });
  assert.equal(streamed.stdout, 'ab');
  assert.deepEqual(chunks, ['a', 'b']);
  await assert.rejects(execute([process.execPath, '-e', 'process.stdout.write("partial");setInterval(()=>{},1000)'], { timeoutMs: 500 }), error => {
    assert.match(error.message, /timed out/);
    assert.equal(error.stdout, 'partial');
    return true;
  });
  // A listener that throws stops the process, as an abort would.
  await assert.rejects(execute([process.execPath, '-e', 'process.stdout.write("x");setInterval(()=>{},1000)'], { onStdout: () => { throw new Error('Enough'); } }), /Enough/);
});

test('subprocess output limits count raw UTF-8 bytes across both streams', async () => {
  const stdout = [process.execPath, '-e', 'process.stdout.write("€".repeat(5))'];
  assert.equal((await execute(stdout, { maxBytes: 15 })).stdout, '€'.repeat(5));
  await assert.rejects(execute(stdout, { maxBytes: 14 }), /output limit/);
  await assert.rejects(execute([process.execPath, '-e', 'process.stdout.write("€");process.stderr.write("€")'], { maxBytes: 5 }), /output limit/);
});

for (const cause of ['timeout', 'abort', 'output']) test(`subprocess ${cause} settles while an escaped descendant holds both pipes`, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-descendant-'));
  const pidFile = join(root, 'pid');
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  const descendant = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));${cause === 'output' ? 'process.stdout.write("x".repeat(1024));' : ''}setTimeout(()=>process.exit(),8000);`;
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{detached:true,stdio:['ignore','inherit','inherit']}).unref();setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const operation = execute([process.execPath, '-e', child, pidFile], { timeoutMs: cause === 'timeout' ? 1500 : 8000, maxBytes: 64, signal: controller.signal })
    .then(() => ({ success: true }), error => ({ error }));
  if (cause === 'abort') {
    for (let attempt = 0; ; attempt++) {
      try { await readFile(pidFile); break; }
      catch { assert(attempt < 150, 'Descendant never became ready'); await delay(20); }
    }
    controller.abort();
  }
  let watchdog;
  try {
    const result = await Promise.race([operation, new Promise(resolve => { watchdog = setTimeout(() => resolve({ hung: true }), 3500); })]);
    assert(!result.hung, 'execute did not settle after cancellation; inherited pipes are still open');
    assert(result.error, 'Expected subprocess failure');
    assert.match(result.error.message, cause === 'timeout' ? /timed out/ : cause === 'abort' ? /aborted/ : /output limit/);
  } finally { clearTimeout(watchdog); }
});
