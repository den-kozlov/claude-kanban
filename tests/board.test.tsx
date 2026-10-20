import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { issue, pr } from './fixtures'

const PANE = {
  plugin: 'kanban-board',
  component: 'Pane',
  requestId: 'board',
  props: {
    title: 'Board',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const OPEN = [
  issue(1, { title: 'Write the spec', labelNames: ['ready-for-human'], priority: 'High' }),
  issue(2, { title: 'Fix the login', labelNames: ['ready-for-human', 'bug'] }),
  issue(3, { title: 'Triage me', labelNames: ['needs-triage'] }),
  issue(4, { title: 'Under review' }),
  issue(5, { title: 'The PRD', labelNames: ['prd'] }),
]

const page = <T,>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes })

/** Stands for git and gh beneath the plugin; returns the argv of every `gh issue view`. */
function fakeHost(on: On): string[][] {
  const opened: string[][] = []
  on('process.run', (_, e) => {
    const [tool, command] = e.argv
    const answer = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (tool === 'gh' && command === 'repo') return answer('o/r\n')
    if (tool === 'gh' && command === 'issue') {
      opened.push([...e.argv])
      return answer('')
    }
    if (tool === 'gh' && command === 'api') {
      const query = e.argv.find(arg => arg.startsWith('query=')) ?? ''
      if (query.includes('pullRequests(')) {
        return answer(JSON.stringify({ data: { repository: { pullRequests: page([pr(9, 'issue-4', '', 'SUCCESS')]) } } }))
      }
      if (query.includes('search(')) {
        return answer(JSON.stringify({ data: { search: page([issue(6, { title: 'Shipped' })]) } }))
      }
      return answer(JSON.stringify({ data: { repository: { issues: page(OPEN) } } }))
    }
    return answer('')
  })
  return opened
}

test('the board shows the issues in their columns and answers its keys', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 20, 12) })
  let isOpen = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'board', title: 'Board', isShown: true, isFocused: true, isPlaced: true }] : [],
  }))
  on('ui.open', () => {
    isOpen = true
    return { value: { isPlaced: true } }
  })
  const opened = fakeHost(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern, in: 'board' }))?.text

    expect(await text(/^Ready for human 2/)).toBeDefined()
    expect(await text(/^Review 1/)).toBeDefined()
    expect(await text(/PR #9 ✓/)).toBeDefined()
    // The container is a filter, not a card; Done is hidden at first.
    expect(await text(/The PRD/)).toBeUndefined()
    expect(await text(/Shipped/)).toBeUndefined()

    await ui.key({ key: 'd', in: 'board' })
    expect(await text(/Shipped/)).toBeDefined()

    // The first card is #3 (Triage, the first column with cards); → moves to #1 (High).
    await ui.key({ key: 'right', in: 'board' })
    await ui.key({ key: 'o', in: 'board' })
    expect(opened.at(-1)).toEqual(['gh', 'issue', 'view', '1', '--web', '-R', 'o/r'])

    await ui.key({ key: 'f', in: 'board' })
    await ui.key({ key: 'down', in: 'board' })
    await ui.key({ key: 'return', in: 'board' })
    expect(await text(/filter #5/)).toBeDefined()
    expect(await text(/Write the spec/)).toBeUndefined()

    await ui.unmount()
  }
})
