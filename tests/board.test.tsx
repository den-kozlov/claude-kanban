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
  id: 'I_2',
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

const PRIORITY_FIELD = {
  __typename: 'IssueFieldSingleSelect',
  id: 'F_priority',
  name: 'Priority',
  options: ['Urgent', 'High', 'Medium', 'Low'].map(name => ({ id: `O_${name}`, name })),
}

type HostOptions = {
  owner?: 'organization' | 'user'
  failWrites?: boolean
  term?: string
  /** What the plugin's store holds at the start. */
  store?: Record<string, unknown>
  /** Files by absolute path, `.claude/kanban.json` among them; the test may change them. */
  files?: Map<string, string>
  /** The worktree the session runs in; the main one, `/repo`, when left out. */
  worktree?: string
}

/**
 * Stands for git and gh beneath the plugin. Returns the argv of every
 * `gh issue view` and the variables of every Priority write.
 */
function fakeHost(on: On, options: HostOptions = {}) {
  const opened: string[][] = []
  const writes: Record<string, string>[] = []
  const tabs: string[][] = []
  // How many times the board read the open issues: once per refresh.
  const fetches = { count: 0 }
  on('process.run', (_, e) => {
    const [tool, command] = e.argv
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'HTTP 403', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (tool === 'gh' && command === 'repo') return answer('o/r\n')
    if (tool === 'git' && command === 'rev-parse') return answer(e.argv.includes('--show-toplevel') ? `${options.worktree ?? '/repo'}\n` : '/repo/.git\n')
    if (tool === 'orca') {
      tabs.push([...e.argv])
      return answer(JSON.stringify({ ok: true, result: { terminal: { handle: 'term_42' } } }))
    }
    if (tool === 'osascript') {
      tabs.push([...e.argv])
      // The new-tab script answers the session's id; the focus script that it found the tab.
      return answer(e.argv[2]?.includes('create tab') === true ? 'ITERM-1\n' : 'found\n')
    }
    if (tool === 'gh' && command === 'issue') {
      opened.push([...e.argv])
      return answer('')
    }
    if (tool === 'gh' && command === 'api') {
      const query = e.argv.find(arg => arg.startsWith('query=')) ?? ''
      if (query.includes('repositoryOwner(')) {
        const owner =
          options.owner === 'user'
            ? { __typename: 'User' }
            : { __typename: 'Organization', issueFields: { nodes: [{ __typename: 'IssueFieldDate' }, PRIORITY_FIELD] } }
        return answer(JSON.stringify({ data: { repositoryOwner: owner } }))
      }
      if (query.includes('IssueFieldValue(')) {
        if (options.failWrites === true) return answer('', 1)
        const variables = e.argv
          .filter(arg => !arg.startsWith('query=') && arg.includes('='))
          .map(arg => arg.split('=') as [string, string])
        writes.push({ mutation: query.includes('setIssueFieldValue(') ? 'set' : 'delete', ...Object.fromEntries(variables) })
        return answer(JSON.stringify({ data: { ok: true } }))
      }
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
      fetches.count += 1
      return answer(JSON.stringify({ data: { repository: { issues: page(OPEN) } } }))
    }
    return answer('')
  })
  return { opened, writes, tabs, fetches }
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
async function openBoard($: Engine, on: On, options: HostOptions = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 20, 12) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'board' } }))
  mock.env(on, options.term === undefined ? {} : { TERM_PROGRAM: options.term })
  // The plugin's store, in memory.
  const stored = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const files = options.files ?? new Map<string, string>()
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  const panes = fakePanes(on)
  const { opened, writes, tabs, fetches } = fakeHost(on, options)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })
  await clock.settle()
  return { clock, panes, opened, writes, toasts, tabs, stored, fetches }
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

test('Enter opens the detail view in the board; Backspace goes back to the columns', async ($, on) => {
  const { clock, opened } = await openBoard($, on)

  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text
  // The first card is #3; → moves to #1, ↓ to #2.
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'down', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()

  expect(await text(/^#2 Fix the login$/)).toBeDefined()
  expect(await text(/^open · Ready for human · Priority none$/)).toBeDefined()
  expect(await text(/^ready-for-human, bug$/)).toBeDefined()
  expect(await text(/^alice$/)).toBeDefined()
  expect(await text(/^Comments 4, the last 3$/)).toBeDefined()
  expect(await text(/^ghost · 2026-10-19$/)).toBeDefined()
  expect(await text(/^The login \*\*fails\*\* on Safari\.$/)).toBeDefined()
  expect(await text(/⌫ back/)).toBeDefined()
  expect(await text(/^Ready for human 2$/)).toBeUndefined()

  await board.key({ key: 'o', in: 'board' })
  expect(opened.at(-1)).toEqual(['gh', 'issue', 'view', '2', '--web', '-R', 'o/r'])

  // The links: the parent #5 first, ↓ the blocker #3 (both on screen); Enter shows it.
  await board.key({ key: 'down', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()
  expect(await text(/^#3 Triage me$/)).toBeDefined()

  // Back on the columns, the issue shown last is the one selected.
  await board.key({ key: 'backspace', in: 'board' })
  await clock.settle()
  expect(await text(/^Ready for human 2$/)).toBeDefined()
  await board.key({ key: 'o', in: 'board' })
  expect(opened.at(-1)).toEqual(['gh', 'issue', 'view', '3', '--web', '-R', 'o/r'])

  // The board closed with the view open opens again on its columns.
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()
  expect(await text(/^#3 Triage me$/)).toBeDefined()
  for (let run = 0; run < 2; run += 1) {
    await $.command.run({
      command: 'board',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    })
  }
  await clock.settle()
  expect(await text(/^Ready for human 2$/)).toBeDefined()

  await board.unmount()
})

test('a press on a link in the detail view shows that issue', async ($, on) => {
  const { clock } = await openBoard($, on)
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'down', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()

  // The status bar, the title, the facts, a blank row, Labels, Assignees, then Parent: row 6.
  await board.pointer({ type: 'down', button: 'left', x: 14, y: 6, in: 'board' })
  await clock.settle()
  expect(await text(/^#5 The PRD$/)).toBeDefined()
  await board.unmount()
})

test('p cycles the Priority of the selected card and P clears it; the card moves at once', async ($, on) => {
  const { clock, writes } = await openBoard($, on)
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text

  expect(await text(/p\/P priority/)).toBeDefined()
  // → selects #1, High.
  await board.key({ key: 'right', in: 'board' })
  expect(await text(/^High$/)).toBeDefined()

  // The card moves with each press; one write goes 2 s after the last press.
  await board.key({ key: 'p', in: 'board' })
  expect(await text(/^Medium$/)).toBeDefined()
  await clock.advance(1000)
  await board.key({ key: 'p', in: 'board' })
  expect(await text(/^Low$/)).toBeDefined()
  await clock.advance(1999)
  expect(writes).toEqual([])
  await clock.advance(1)
  expect(writes).toEqual([{ mutation: 'set', issue: 'I_1', field: 'F_priority', option: 'O_Low' }])

  await board.key({ key: 'P', shift: true, in: 'board' })
  expect(await text(/^Low$/)).toBeUndefined()
  await clock.advance(2000)
  expect(writes.at(-1)).toEqual({ mutation: 'delete', issue: 'I_1', field: 'F_priority' })

  // A refresh that starts after the writes ended shows GitHub's answer (the fake still says High).
  await board.key({ key: 'r', in: 'board' })
  await clock.settle()
  expect(await text(/^High$/)).toBeDefined()

  // Round the whole cycle back to High: nothing to write.
  for (let press = 0; press < 5; press += 1) await board.key({ key: 'p', in: 'board' })
  await clock.advance(2000)
  expect(writes).toHaveLength(2)
  expect(await text(/^High$/)).toBeDefined()

  await board.unmount()
})

test('a failed Priority write puts the card back and says why', async ($, on) => {
  const { clock, toasts } = await openBoard($, on, { failWrites: true })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text

  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'p', in: 'board' })
  expect(await text(/^Medium$/)).toBeDefined()
  // The write goes 2 s after the press, and is tried again after 1, 2 and 4 seconds before it fails.
  await clock.advance(2000 + 8000)

  expect(await text(/^High$/)).toBeDefined()
  expect(toasts.at(-1)).toBe('Could not set the Priority of #1: HTTP 403')
  await board.unmount()
})

test('p does nothing but a toast where the owner has no Priority field', async ($, on) => {
  const { clock, writes, toasts } = await openBoard($, on, { owner: 'user' })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await board.find({ type: 'Text', text: /p\/P priority/, in: 'board' })).toBeUndefined()
  await board.key({ key: 'p', in: 'board' })
  await clock.settle()

  expect(writes).toEqual([])
  expect(toasts.at(-1)).toBe('o has no Priority issue field')
  await board.unmount()
})

test('p in the detail view cycles the Priority of the issue it shows', async ($, on) => {
  const { clock, writes } = await openBoard($, on)
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text
  // → #1, ↓ #2: no Priority.
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'down', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()

  await board.key({ key: 'p', in: 'board' })
  expect(await text(/Priority Urgent/)).toBeDefined()
  await clock.advance(2000)
  expect(writes.at(-1)).toEqual({ mutation: 'set', issue: 'I_2', field: 'F_priority', option: 'O_Urgent' })

  await board.key({ key: 'backspace', in: 'board' })
  await clock.settle()
  expect(await text(/^Urgent$/)).toBeDefined()
  await board.unmount()
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NOW = Date.UTC(2026, 9, 20, 12)

test('s starts a Triage card with /triage in a new Orca tab and records the session', async ($, on) => {
  const { clock, tabs, toasts, stored } = await openBoard($, on, { term: 'Orca' })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await board.find({ type: 'Text', text: /s start/, in: 'board' })).toBeDefined()
  // The first card is #3, in Triage with `needs-triage`.
  await board.key({ key: 's', in: 'board' })
  await clock.settle()

  const argv = tabs.at(-1) ?? []
  expect(argv.slice(0, 7)).toEqual(['orca', 'terminal', 'create', '--worktree', 'path:/repo', '--title', '#3 Triage me'])
  expect(argv[7]).toBe('--command')
  expect(argv.slice(9)).toEqual(['--focus', '--json'])
  const [, recordId, sessionId, rest] = /^KANBAN_BOARD_SESSION=(\S+) claude --session-id (\S+) (.*)$/.exec(argv[8] ?? '') ?? []
  expect(sessionId).toMatch(UUID)
  expect(recordId).toBe(sessionId as string)
  expect(rest).toBe("--name '#3 Triage me' '/triage #3'")

  const records = stored.get('sessions:o/r') as Record<string, unknown[]>
  expect(records['3']).toEqual([{ sessionId: sessionId as string, terminal: { app: 'orca', id: 'term_42' }, startedAt: NOW }])
  expect(toasts.at(-1)).toBe('Started #3 in a new Orca tab: /triage #3')
  // The session starts: the card goes to In progress until it ends.
  expect(await board.find({ type: 'Text', text: /^ *starting$/, in: 'board' })).toBeDefined()
  expect(await board.find({ type: 'Text', text: /^In progress 1/, in: 'board' })).toBeDefined()
  // It never reports (the plugin did not load there): after a minute it reads as ended.
  await clock.advance(60_000)
  expect(await board.find({ type: 'Text', text: /^ *ended$/, in: 'board' })).toBeDefined()
  expect(await board.find({ type: 'Text', text: /^Triage 1/, in: 'board' })).toBeDefined()
  await board.unmount()
})

test('outside Orca, s opens an iTerm tab in the repository root', async ($, on) => {
  const { clock, tabs, toasts, stored } = await openBoard($, on)
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // → #1, Ready for human.
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 's', in: 'board' })
  await clock.settle()

  const argv = tabs.at(-1) ?? []
  expect(argv[0]).toBe('osascript')
  expect(argv.at(-1)).toMatch(
    /^cd '\/repo' && KANBAN_BOARD_SESSION=\S+ claude --session-id \S+ --name '#1 Write the spec' 'Start implementing issue #1'$/,
  )
  expect(toasts.at(-1)).toBe('Started #1 in a new iTerm tab: Start implementing issue #1')
  const records = stored.get('sessions:o/r') as Record<string, { terminal: unknown }[]>
  expect(records['1']?.[0]?.terminal).toEqual({ app: 'iterm', id: 'ITERM-1' })
  await board.unmount()
})

test('s on a card of a column that does not start says why and opens nothing', async ($, on) => {
  const { clock, tabs, toasts } = await openBoard($, on, { term: 'Orca' })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // → #1 (Ready for human), → #4 (Review).
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 's', in: 'board' })
  await clock.settle()

  expect(tabs).toEqual([])
  expect(toasts.at(-1)).toBe('Review: the board started no session for it')
  await board.unmount()
})

test('s in the detail view starts the card, or the view shows why it does not start', async ($, on) => {
  const { clock, tabs } = await openBoard($, on, { term: 'Orca' })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text

  // → #1, → #4 (Review).
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()
  expect(await text(/^Start: /)).toBe('Start: Review: the board started no session for it')
  expect(await text(/ s start/)).toBeUndefined()

  await board.key({ key: 'backspace', in: 'board' })
  await board.key({ key: 'left', in: 'board' })
  await board.key({ key: 'return', in: 'board' })
  await clock.settle()
  expect(await text(/^Start: /)).toBeUndefined()
  expect(await text(/ s start/)).toBeDefined()
  await board.key({ key: 's', in: 'board' })
  await clock.settle()
  expect(tabs.at(-1)?.[6]).toBe('#1 Write the spec')

  await board.unmount()
})

test('a running session puts its card in In progress; s brings its tab forward', async ($, on) => {
  const { clock, tabs } = await openBoard($, on, {
    term: 'Orca',
    store: {
      'sessions:o/r': { '2': [{ sessionId: 'rec-2', terminal: { app: 'orca', id: 'term_7' }, startedAt: NOW - 600_000 }] },
      'live:rec-2': { state: 'waiting', at: NOW - 1_000, sessionId: 'rec-2' },
    },
  })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await board.find({ type: 'Text', text: /^In progress 1/, in: 'board' })).toBeDefined()
  expect(await board.find({ type: 'Text', text: /^ *waiting for input$/, in: 'board' })).toBeDefined()
  // #3 (Triage), → #1 (Ready for human), → #2 (In progress).
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 's', in: 'board' })
  await clock.settle()
  expect(tabs.at(-1)).toEqual(['orca', 'terminal', 'switch', '--terminal', 'term_7'])

  // The session falls silent: 30 s on, it reads as ended and the card goes back to its label column.
  await clock.advance(30_000)
  expect(await board.find({ type: 'Text', text: /^In progress 1/, in: 'board' })).toBeUndefined()
  expect(await board.find({ type: 'Text', text: /^ *ended$/, in: 'board' })).toBeDefined()
  await board.unmount()
})

test('s on a Review card resumes its last session in a new tab', async ($, on) => {
  const { clock, tabs, toasts, stored } = await openBoard($, on, {
    store: {
      'sessions:o/r': { '4': [{ sessionId: 'rec-4', terminal: null, startedAt: NOW - 600_000 }] },
      // A /clear moved the session to a new id.
      'live:rec-4': { state: 'ended', at: NOW - 500_000, sessionId: 'later-4' },
    },
  })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // #3, → #1, → #4 (Review).
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 'right', in: 'board' })
  await board.key({ key: 's', in: 'board' })
  await clock.settle()

  expect(tabs.at(-1)?.at(-1)).toBe("cd '/repo' && KANBAN_BOARD_SESSION=rec-4 claude --resume later-4")
  expect(toasts.at(-1)).toBe('Resumed #4 in a new iTerm tab')
  const records = stored.get('sessions:o/r') as Record<string, unknown[]>
  expect(records['4']).toEqual([{ sessionId: 'rec-4', terminal: { app: 'iterm', id: 'ITERM-1' }, startedAt: NOW }])
  expect(await board.find({ type: 'Text', text: /^ *starting$/, in: 'board' })).toBeDefined()
  await board.unmount()
})

test('.claude/kanban.json changes the board at each refresh; a wrong part is skipped and named', async ($, on) => {
  const path = '/repo/.claude/kanban.json'
  const files = new Map([[path, JSON.stringify({ columns: { readyForHuman: ['human'] }, doneDays: 0 })]])
  const { clock, toasts, fetches } = await openBoard($, on, { files })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = async (pattern: RegExp) => (await board.find({ type: 'Text', text: pattern, in: 'board' }))?.text

  // `ready-for-human` names no column now: #1 and #2 go to Triage beside #3.
  expect(await text(/^Triage 3$/)).toBeDefined()
  expect(await text(/^Ready for human/)).toBeUndefined()
  expect(toasts.at(-1)).toBe('.claude/kanban.json: doneDays must be a whole number from 1 to 365; the board skips it')
  expect(await text(/⚠ kanban\.json: doneDays must be/)).toBeDefined()

  // A file that is not JSON: the defaults, and a toast.
  files.set(path, '{ "columns": ')
  await board.key({ key: 'r', in: 'board' })
  await clock.settle()
  expect(await text(/^Ready for human 2$/)).toBeDefined()
  expect(toasts.at(-1)).toMatch(/^\.claude\/kanban\.json: it is not JSON \(.+\); the board skips it$/)

  // A new refreshSeconds takes effect at the refresh that reads it.
  files.set(path, JSON.stringify({ refreshSeconds: 15 }))
  await board.key({ key: 'r', in: 'board' })
  await clock.settle()
  const before = fetches.count
  await clock.advance(15_000)
  expect(fetches.count).toBe(before + 1)

  // No file: the defaults, and no toast.
  const said = toasts.length
  files.delete(path)
  await board.key({ key: 'r', in: 'board' })
  await clock.settle()
  expect(toasts.length).toBe(said)
  expect(await text(/⚠ kanban\.json/)).toBeUndefined()
  await board.unmount()
})

test("a session in a linked worktree with no kanban.json of its own reads the main worktree's", async ($, on) => {
  const files = new Map([['/repo/.claude/kanban.json', JSON.stringify({ columns: { readyForHuman: ['human'] } })]])
  const { clock } = await openBoard($, on, { files, worktree: '/worktrees/feature' })
  const board = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await board.find({ type: 'Text', text: /^Triage 3$/, in: 'board' })).toBeDefined()
  // The worktree's own file wins.
  files.set('/worktrees/feature/.claude/kanban.json', '{}')
  await board.key({ key: 'r', in: 'board' })
  await clock.settle()
  expect(await board.find({ type: 'Text', text: /^Ready for human 2$/, in: 'board' })).toBeDefined()
  await board.unmount()
})
