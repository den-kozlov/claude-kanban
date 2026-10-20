import { describe, expect, test } from 'claude-code/testing'

import {
  buildBoard,
  DEFAULT_CONFIG,
  nextPriority,
  priorityFieldOf,
  prsByIssue,
  viewColumns,
  type Snapshot,
} from '../hooks/lib/model'
import type { Priority } from '../types'
import { issue, pr } from './fixtures'

const snapshot = (part: Partial<Snapshot>): Snapshot => ({ repo: 'o/r', open: [], done: [], prs: [], ...part })

const columnOf = (board: ReturnType<typeof buildBoard>, number: number) =>
  board.cards.find(card => card.number === number)?.column

describe('column rules', () => {
  test('an issue goes to the first column whose rule matches', async () => {
    const board = buildBoard(
      snapshot({
        open: [
          issue(1, { labelNames: ['needs-triage'] }),
          issue(2, { labelNames: ['needs-info'] }),
          issue(3, { labelNames: ['ready-for-agent'] }),
          issue(4, { labelNames: ['ready-for-human'] }),
          issue(5),
          issue(6, { labelNames: ['ready-for-agent'], blockedBy: { nodes: [{ number: 1, state: 'OPEN' }] } }),
          issue(7, { labelNames: ['ready-for-agent'], blockedBy: { nodes: [{ number: 1, state: 'CLOSED' }] } }),
          issue(8, { labelNames: ['ready-for-human'] }),
          issue(9, { blockedBy: { nodes: [{ number: 1, state: 'OPEN' }] } }),
        ],
        done: [issue(10, { labelNames: ['ready-for-human'] })],
        prs: [pr(20, 'feature/issue-9')],
      }),
      ['issue-8-start'],
      DEFAULT_CONFIG,
      0,
    )

    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => columnOf(board, n))).toEqual([
      'triage',
      'needsInfo',
      'readyForAgent',
      'readyForHuman',
      'triage',
      'blocked',
      'readyForAgent',
      'inProgress',
      'review',
      'done',
    ])
  })

  test('a linked open PR puts the issue in Review', async () => {
    const board = buildBoard(
      snapshot({
        open: [
          issue(3, {
            closedByPullRequestsReferences: { nodes: [{ number: 30, state: 'OPEN', isDraft: true }] },
          }),
        ],
      }),
      [],
      DEFAULT_CONFIG,
      0,
    )

    expect(board.cards[0]?.column).toBe('review')
    expect(board.cards[0]?.pr).toEqual({ number: 30, isDraft: true, ci: null })
  })

  test('a Sandcastle branch puts the issue in In progress with its badge', async () => {
    const board = buildBoard(snapshot({ open: [issue(4)] }), ['sandcastle/issue-4'], DEFAULT_CONFIG, 0)

    expect(board.cards[0]).toMatchObject({ column: 'inProgress', isSandcastle: true })
  })

  test('a running session of the board puts the issue in In progress; an ended one leaves it', async () => {
    const sessions = new Map([
      [1, 'working'],
      [2, 'ended'],
    ] as const)
    const board = buildBoard(
      snapshot({ open: [issue(1, { labelNames: ['ready-for-human'] }), issue(2, { labelNames: ['ready-for-human'] })] }),
      [],
      DEFAULT_CONFIG,
      0,
      { sessions },
    )

    expect(board.cards.find(card => card.number === 1)).toMatchObject({ column: 'inProgress', session: 'working', startAs: 'focus' })
    expect(board.cards.find(card => card.number === 2)).toMatchObject({ column: 'readyForHuman', session: 'ended', startAs: 'start' })
  })
})

describe('containers', () => {
  test('a container is a filter, never a card', async () => {
    const board = buildBoard(
      snapshot({
        open: [issue(1, { labelNames: ['prd'] }), issue(2, { parent: { number: 1 } }), issue(3)],
        done: [issue(4, { labelNames: ['wayfinder:map'] })],
      }),
      [],
      DEFAULT_CONFIG,
      0,
    )

    expect(board.containers).toEqual([{ number: 1, title: 'Issue 1' }])
    expect(board.cards.map(card => card.number)).toEqual([2, 3])
    const filtered = viewColumns(board, { showDone: false, filter: 1 })
    expect(filtered.flatMap(column => column.cards.map(card => card.number))).toEqual([2])
  })
})

describe('cards', () => {
  test('a card shows up to three labels, column labels left out', async () => {
    const board = buildBoard(
      snapshot({ open: [issue(1, { labelNames: ['needs-triage', 'bug', 'ready-for-agent', 'ui', 'api', 'docs'] })] }),
      [],
      DEFAULT_CONFIG,
      0,
    )

    expect(board.cards[0]?.labels).toEqual(['bug', 'ui', 'api'])
  })

  test('cards go by Priority, then by number', async () => {
    const board = buildBoard(
      snapshot({
        open: [
          issue(1),
          issue(2, { priority: 'Low' }),
          issue(3, { priority: 'Urgent' }),
          issue(4, { priority: 'High' }),
          issue(5, { priority: 'High' }),
          issue(6),
        ],
      }),
      [],
      DEFAULT_CONFIG,
      0,
    )

    expect(board.cards.map(card => card.number)).toEqual([3, 4, 5, 2, 1, 6])
  })

  test('Done shows only when asked', async () => {
    const board = buildBoard(snapshot({ open: [issue(1)], done: [issue(2)] }), [], DEFAULT_CONFIG, 0)

    expect(viewColumns(board, { showDone: false, filter: null }).map(column => column.id)).not.toContain('done')
    expect(viewColumns(board, { showDone: true, filter: null }).at(-1)?.cards.map(card => card.number)).toEqual([2])
  })
})

describe('review detection', () => {
  test('a PR matches by issue-N in its branch, then -N at its end, then #N in its body', async () => {
    const byIssue = prsByIssue(
      [
        pr(10, 'feat/issue-1-login', 'Refs #9', 'SUCCESS'),
        pr(11, 'fix-typo-2', '', 'FAILURE'),
        pr(12, 'cleanup', 'Refs #3 and #4, see other/repo#5', 'PENDING'),
      ],
      DEFAULT_CONFIG,
    )

    expect([...byIssue.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(byIssue.get(1)?.ci).toBe('success')
    expect(byIssue.get(2)?.ci).toBe('failure')
    expect(byIssue.get(4)).toEqual({ number: 12, isDraft: false, ci: 'pending' })
  })
})

describe('priority', () => {
  const field = priorityFieldOf([
    { __typename: 'IssueFieldDate' },
    {
      __typename: 'IssueFieldSingleSelect',
      id: 'F1',
      name: 'Effort',
      options: [{ id: 'E1', name: 'High' }],
    },
    {
      __typename: 'IssueFieldSingleSelect',
      id: 'F2',
      name: 'Priority',
      options: ['Urgent', 'High', 'Medium', 'Low'].map(name => ({ id: `O_${name}`, name })),
    },
  ])

  test('the Priority field and its options are found by name', async () => {
    expect(field).toEqual({
      fieldId: 'F2',
      options: { Urgent: 'O_Urgent', High: 'O_High', Medium: 'O_Medium', Low: 'O_Low' },
    })
    expect(priorityFieldOf([{ __typename: 'IssueFieldSingleSelect', id: 'F1', name: 'Effort' }])).toBeNull()
  })

  test('p cycles none → Urgent → High → Medium → Low → none, P clears', async () => {
    if (field === null) throw new Error('no field')
    const seen: (Priority | null)[] = [null]
    for (let step = 0; step < 5; step += 1) seen.push(nextPriority(seen.at(-1) ?? null, 'cycle', field))

    expect(seen).toEqual([null, 'Urgent', 'High', 'Medium', 'Low', null])
    expect(nextPriority('High', 'clear', field)).toBeNull()
    // A field without some options cycles through those it has.
    expect(nextPriority('Urgent', 'cycle', { fieldId: 'F', options: { Urgent: 'u', Low: 'l' } })).toBe('Low')
  })

  test('a write not yet read back wins over GitHub, and the board says when Priority is off', async () => {
    const board = buildBoard(
      snapshot({ open: [issue(1, { priority: 'Low' }), issue(2, { priority: 'High' })] }),
      [],
      DEFAULT_CONFIG,
      0,
      { overrides: new Map([[1, 'Urgent']]), priorityOff: 'o has no Priority issue field' },
    )

    expect(board.cards.map(card => [card.number, card.priority])).toEqual([
      [1, 'Urgent'],
      [2, 'High'],
    ])
    expect(board.priorityOff).toBe('o has no Priority issue field')
  })
})
