import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callClaude, callCommandAgent } from '../src/agents.mjs';

test('terminal Claude receives image blocks and no computer/shell/file/MCP tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mod-ux-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, 'frame.png');
  const bytes = Buffer.from('fixture image bytes');
  await writeFile(image, bytes);
  let captured;
  const result = await callClaude({ role: 'tester', observation: { screenshotPath: image, elements: [] } }, {
    budgetUsd: 0.25,
    executeCommand: async (argv, options) => {
      captured = { argv, input: JSON.parse(options.input) };
      return { stdout: JSON.stringify({ type: 'result', subtype: 'success', structured_output: { status: 'blocked', reason: 'fixture' }, total_cost_usd: 0.01 }) };
    },
  });
  assert(captured.argv.includes('--safe-mode'));
  assert(captured.argv.includes('--strict-mcp-config'));
  assert.equal(captured.argv[captured.argv.indexOf('--tools') + 1], '');
  assert.equal(captured.argv[captured.argv.indexOf('--max-budget-usd') + 1], '0.25');
  assert.equal(captured.input.message.content[1].type, 'image');
  assert.equal(captured.input.message.content[1].source.data, bytes.toString('base64'));
  assert.equal(result.result.status, 'blocked');
  assert.equal(result.usage.costUsd, 0.01);
});

test('terminal Claude reports actionable auth errors without dumping its init event', async () => {
  await assert.rejects(callClaude({ role: 'tester' }, {
    executeCommand: async () => {
      const error = new Error('exited 1');
      error.stdout = '{"type":"system","privateMetadata":"omit"}\n{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}\n';
      throw error;
    },
  }), /Claude: Not logged in/);
});

test('a terminal Claude refusal or malformed structured response fails closed', async () => {
  await assert.rejects(callClaude({ role: 'tester' }, { executeCommand: async () => ({ stdout: '{"type":"result","subtype":"success","is_error":true}' }) }), /successful structured result/);
  await assert.rejects(callClaude({ role: 'tester' }, { executeCommand: async () => ({ stdout: '{"type":"result","subtype":"success"}' }) }), /no structured_output/);
});

test('generic command agent completes the JSON stdin/stdout protocol', async () => {
  const request = { role: 'tester', goal: 'fixture', observation: { elements: [] } };
  const response = await callCommandAgent([process.execPath, '-e', 'let input=""; process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>console.log(JSON.stringify({status:"blocked",reason:JSON.parse(input).goal})))'], request);
  assert.deepEqual(response, { status: 'blocked', reason: 'fixture' });
});
