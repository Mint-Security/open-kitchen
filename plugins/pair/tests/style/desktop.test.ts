import { expect, test } from 'claude-code/testing'

import { desktopLabelOf } from '../../hooks/display/style/desktop'
import { toolViewOf } from '../../hooks/display/style/tool-rows'

const call = (tool: string, input: Record<string, unknown>, result: unknown = {}, isError = false) => ({
  tool,
  view: toolViewOf(tool, input, result, '', isError, '/repo'),
  isError
})

test("a run of tool calls is labelled as Claude Code's desktop app labels it", () => {
  const command = (text: string) => call('Bash', { command: text }, { stdout: '', stderr: '' })
  expect(desktopLabelOf([command('ls'), command('pwd'), command('date'), command('id')])).toBe('Ran 4 commands')
  expect(desktopLabelOf([command('ls'), call('mcp__terminal__read_terminal', { tab_id: 'c1' })])).toBe('Ran a command, used a tool')
  expect(desktopLabelOf([call('Read', { file_path: '/repo/a.ts' }), call('Read', { file_path: '/repo/a.ts' }), call('Grep', { pattern: 'x' })])).toBe(
    'Read a file, searched code'
  )
  expect(
    desktopLabelOf([command('ls'), call('Read', { file_path: '/repo/a.ts' }), call('Edit', { file_path: '/repo/b.ts' }), call('Glob', { pattern: '*' }), call('Skill', {})])
  ).toBe('Edited a file, read a file, and 3 more steps')
})

test('a single call reads as its own action, a command by its description', () => {
  expect(desktopLabelOf([call('Bash', { command: 'npm test', description: 'Run the tests' }, { stdout: 'ok', stderr: '' })])).toBe('Run the tests')
  expect(desktopLabelOf([call('Bash', { command: 'npm test' }, { stdout: 'ok', stderr: '' })])).toBe('Ran a command')
  expect(desktopLabelOf([call('Write', { file_path: '/repo/hooks/pane.tsx', content: 'a\nb\nc' })])).toBe('Created pane.tsx +3 -0')
  const patch = { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] }
  expect(desktopLabelOf([call('Edit', { file_path: '/repo/src/x.ts' }, patch)])).toBe('Edited x.ts +2 -1')
  expect(desktopLabelOf([call('Read', { file_path: '/repo/README.md' })])).toBe('Read README.md')
  expect(desktopLabelOf([call('Grep', { pattern: 'x' })])).toBe('Searched code')
  expect(desktopLabelOf([call('Bash', { command: 'false' }, undefined, true)])).toBe('Command failed')
})
