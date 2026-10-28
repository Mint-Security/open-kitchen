import { expect, test } from 'claude-code/testing'

import { relativeTo, toolViewOf } from '../../hooks/display/style/tool-rows'

test('tool calls become what the transcript draws for them', () => {
  const bash = toolViewOf('Bash', { command: 'npm test\n--watch=false' }, { stdout: 'PASS a\nPASS b', stderr: 'warn', interrupted: false }, '', false, '/repo')
  expect(bash).toMatchObject({ label: 'Bash', args: 'npm test…', group: null, summary: null, output: ['PASS a', 'PASS b', 'warn'], totalLines: 3, code: null })
  const long = toolViewOf('Bash', { command: 'seq 100' }, { stdout: Array.from({ length: 100 }, (_, i) => String(i)).join('\n'), stderr: '' }, '', false, '/repo')
  expect([long.output.length, long.totalLines]).toEqual([40, 100])
  expect(toolViewOf('Bash', { command: 'true' }, { stdout: '', stderr: '' }, '', false, '/repo')).toMatchObject({ output: [], totalLines: 0 })

  expect(toolViewOf('Read', { file_path: '/repo/src/a.ts' }, {}, '', false, '/repo')).toMatchObject({ label: 'Read', args: 'src/a.ts', group: 'read' })
  expect(toolViewOf('Grep', { pattern: 'TODO', path: '/repo/src' }, {}, '', false, '/repo')).toMatchObject({ label: 'Search', args: 'pattern: "TODO", path: "src"', group: 'search' })
  expect(toolViewOf('Glob', { pattern: '*.ts' }, {}, '', false, '/repo')).toMatchObject({ args: 'pattern: "*.ts"', group: 'search' })

  const edit = toolViewOf(
    'Edit',
    { file_path: '/repo/util.ts', old_string: 'greet', new_string: 'welcome' },
    { structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-export const greet = 1', '+export const welcome = 1', ' export const add = 2'] }] },
    '',
    false,
    '/repo'
  )
  expect(edit.label + '(' + edit.args + ')').toBe('Update(util.ts)')
  expect(edit.summary?.map(span => (span.isBold ? `**${span.text}**` : span.text)).join('')).toBe('Added **1** line, removed **1** line')
  expect(edit.code).toEqual({ source: '@@ -1,2 +1,2 @@\n-export const greet = 1\n+export const welcome = 1\n export const add = 2', path: 'util.ts', format: 'diff', moreLines: 0 })

  const write = toolViewOf('Write', { file_path: '/repo/notes.md', content: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') }, { type: 'create' }, '', false, '/repo')
  expect(write.summary?.map(span => (span.isBold ? `**${span.text}**` : span.text)).join('')).toBe('Wrote **12** lines to **notes.md**')
  expect(write.code).toMatchObject({ format: 'source', path: 'notes.md', moreLines: 2 })
  expect(write.code?.source.split('\n')).toHaveLength(10)

  expect(toolViewOf('WebFetch', { url: 'https://x.dev' }, { bytes: 12_600, code: 200, codeText: 'OK' }, '', false, '/repo').summary?.[0]?.text).toBe('Received 12.3KB (200 OK)')
  expect(toolViewOf('WebSearch', { query: 'syncthing' }, { durationSeconds: 3.2, searchCount: 2 }, '', false, '/repo').summary?.[0]?.text).toBe('Did 2 searches in 3s')
  expect(toolViewOf('mcp__github__get_issue', { owner: 'a', number: 7 }, {}, 'title: x', false, '/repo')).toMatchObject({
    label: 'github - get_issue (MCP)',
    args: 'owner: "a", number: 7',
    output: ['title: x']
  })
  const failed = toolViewOf('Edit', { file_path: '/repo/a.ts', old_string: 'const retries = 1' }, undefined, 'String to replace not found', true, '/repo')
  expect(failed).toMatchObject({ label: 'Update', args: 'a.ts', output: ['String to replace not found'], summary: null })
  expect(toolViewOf('Bash', { command: 'npm test', description: 'Run the tests' }, undefined, 'Exit code 1', true, '/repo')).toMatchObject({
    label: 'Bash',
    args: 'npm test',
    description: 'Run the tests',
    output: ['Exit code 1']
  })
  expect(toolViewOf('Write', { file_path: '/repo/b.ts', content: 'first line of the file' }, undefined, 'File has not been read yet', true, '/repo')).toMatchObject({
    label: 'Write',
    args: 'b.ts',
    code: null
  })
})

test('a hunk over the cap keeps what fits', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `+${'line '.repeat(20)}${i}`)
  const big = toolViewOf('Write', { file_path: '/r/big.ts' }, { type: 'update', structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3000, lines }] }, '', false, '/r')
  expect(big.code?.source.length).toBeLessThanOrEqual(30_000)
  expect(big.code?.source.startsWith('@@ -1,0 +1,3000 @@\n+line')).toBe(true)
  expect((big.code?.moreLines ?? 0) + (big.code?.source.split('\n').length ?? 0) - 1).toBe(3000)
  expect(big.added).toBe(3000)
})

test('paths inside the session folder are drawn relative to it', () => {
  expect(relativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(relativeTo('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
  expect(relativeTo('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
  expect(relativeTo('relative.ts', '/repo')).toBe('relative.ts')
})
