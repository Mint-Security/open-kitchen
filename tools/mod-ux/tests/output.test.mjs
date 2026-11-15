import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivateOutput } from '../src/output.mjs';
import { execute } from '../src/process.mjs';

test('capture destinations inside Git must be ignored, including through symlink parents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await execute(['git', 'init', repo]);
  await writeFile(join(repo, '.gitignore'), '.mod-ux/\n');
  await assert.rejects(assertPrivateOutput(join(repo, 'runs', 'new')), /not ignored/);
  await assertPrivateOutput(join(repo, '.mod-ux', 'new'));
  await assertPrivateOutput(join(repo, 'runs', 'explicit'), { allowUnignored: true });
  await assertPrivateOutput(join(root, 'outside', 'new'));
  const link = join(root, 'linked-repo');
  await symlink(repo, link, 'dir');
  await assert.rejects(assertPrivateOutput(join(link, 'runs', 'new')), /not ignored/);
  await assertPrivateOutput(join(link, '.mod-ux', 'new'));
  await assert.rejects(access(join(repo, 'runs'))); // Validation creates no artifact directories.
});

test('CLI refuses unignored output before invoking the desktop driver', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-output-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute(['git', 'init', root]);
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const scenario = fileURLToPath(new URL('./fixtures/draft-preservation.json', import.meta.url));
  const directory = join(root, 'captures', 'run');
  const args = [process.execPath, cli, 'start', scenario, '--out', directory];
  const options = { env: { ...process.env, MOD_UX_PEEKABOO: join(root, 'no-desktop-driver') } };
  await assert.rejects(execute(args, options), /not ignored/);
  await assert.rejects(access(join(root, 'captures')));
  // The override is explicit and reaches the deliberately absent driver.
  await assert.rejects(execute([...args, '--allow-unignored-output'], options), /no-desktop-driver/);
  await access(join(directory, 'session.json'));
});
