import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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

const DETAIL = {
  number: 2,
  title: 'Fix the login',
  url: 'https://github.com/o/r/issues/2',
  state: 'OPEN',
  body: 'The login **fails** on Safari.',
  labels: { nodes: [{ name: 'ready-for-human' }, { name: 'bug' }] },
  assignees: { nodes: [{ login: 'alice' }] },
  blockedBy: { nodes: [{ number: 3, title: 'Triage me', state: 'OPEN' }] },
  parent: { number: 5, title: 'The PRD', state: 'OPEN' },
  issueFieldValues: { nodes: [] },
  comments: {
    totalCount: 4,
    nodes: [
      { author: { login: 'bob' }, createdAt: '2026-10-18T09:00:00Z', body: 'Seen on iOS too.' },
      { author: null, createdAt: '2026-10-19T09:00:00Z', body: 'Same here.' },
      { author: { login: 'alice' }, createdAt: '2026-10-20T09:00:00Z', body: 'On it.' },
    ],
  },
}

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
      if (query.includes('issue(number:')) {
        const number = Number(e.argv.find(arg => arg.startsWith('number='))?.slice('number='.length))
        const title = OPEN.find(one => one.number === number)?.title ?? `Issue ${number}`
        const found = number === DETAIL.number ? DETAIL : { ...DETAIL, number, title, blockedBy: { nodes: [] } }
        return answer(JSON.stringify({ data: { repository: { issue: found } } }))
      }
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

/** Stands for the engine's panes; returns what each `$.ui.open` asked and the panes open. */
function fakePanes(on: On) {
  const asked: { id: string; title?: string }[] = []
  const open = new Map<string, string>()
  on('ui.panes', () => ({
    value: [...open].map(([id, title]) => ({ id, title, isShown: true, isFocused: true, isPlaced: true })),
  }))
  on('ui.open', (_, e) => {
    asked.push({ id: e.id, title: e.title })
    open.set(e.id, e.title ?? e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  return { asked, open }
}

/** Starts a session and opens the board in it. */
async function openBoard($: Engine, on: On) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 20, 12) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'board' } }))
  const panes = fakePanes(on)
  const opened = fakeHost(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.settle()
  return { clock, panes, opened }
}

test('the board shows the issues in their columns and answers its keys', async ($, on) => {
  const { opened } = await openBoard($, on)

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

test('Enter opens the detail popup; its links select the issue on the board', async ($, on) => {
  const { clock, panes, opened } = await openBoard($, on)

  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The first card is #3; → moves to #1, ↓ to #2.
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'down', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()
  expect(panes.asked.at(-1)).toEqual({ id: 'issue', title: '#2 Fix the login' })

  const popup = await $.ui.mount({ ...PANE, requestId: 'issue', props: { ...PANE.props, title: '#2' }, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await popup.find({ type: 'Text', text: pattern }))?.text
  expect(await text(/^#2 Fix the login$/)).toBeDefined()
  expect(await text(/open · Ready for human · Priority none/)).toBeDefined()
  expect(await text(/ready-for-human, bug/)).toBeDefined()
  expect(await text(/^alice$/)).toBeDefined()
  expect(await text(/Comments 4, the last 3/)).toBeDefined()
  expect(await text(/ghost · 2026-10-19/)).toBeDefined()
  expect((await popup.find({ type: 'Markdown', text: /fails/ }))?.text).toBe('The login **fails** on Safari.')

  await popup.press({ key: 'open' })
  expect(opened.at(-1)).toEqual(['gh', 'issue', 'view', '2', '--web', '-R', 'o/r'])

  // The blocker's link shows #3 in the popup and selects it on the board.
  await popup.press({ key: 'link:3' })
  await clock.settle()
  expect(panes.asked.at(-1)).toEqual({ id: 'issue', title: '#3 Triage me' })
  expect(await text(/^#3 Triage me$/)).toBeDefined()
  await board.key({ key: 'o', in: 'board' })
  expect(opened.at(-1)).toEqual(['gh', 'issue', 'view', '3', '--web', '-R', 'o/r'])

  // Closing the board closes the popup with it.
  await $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  expect([...panes.open.keys()]).toEqual([])

  await popup.unmount()
  await board.unmount()
})
