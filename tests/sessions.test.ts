import { describe, expect, test } from 'claude-code/testing'

import {
  issueSessionOf,
  recordsOf,
  reportOf,
  stateOf,
  withRecord,
  withReopened,
  type Report,
  type SessionRecord,
} from '../hooks/lib/sessions'

const NOW = Date.UTC(2026, 9, 20, 12)

const record = (sessionId: string, startedAt = NOW - 600_000): SessionRecord => ({
  sessionId,
  terminal: { app: 'orca', id: `term_${sessionId}` },
  startedAt,
})

const report = (state: Report['state'], at = NOW - 5_000, sessionId = 'a'): Report => ({ state, at, sessionId })

describe('session records', () => {
  test("stage 4's records read as Orca handles; malformed ones are left out", async () => {
    const stored = {
      '3': [
        { sessionId: 'a', terminal: 'term_1', startedAt: 1 },
        { sessionId: 'b', terminal: null, startedAt: 2 },
        { sessionId: 'c', terminal: { app: 'iterm', id: 'X' }, startedAt: 3 },
        { terminal: null, startedAt: 4 },
      ],
      '4': 'nonsense',
    }

    expect(recordsOf(stored)).toEqual({
      '3': [
        { sessionId: 'a', terminal: { app: 'orca', id: 'term_1' }, startedAt: 1 },
        { sessionId: 'b', terminal: null, startedAt: 2 },
        { sessionId: 'c', terminal: { app: 'iterm', id: 'X' }, startedAt: 3 },
      ],
    })
    expect(recordsOf(null)).toEqual({})
    expect(reportOf({ state: 'working', at: 1, sessionId: 'a' })).toEqual({ state: 'working', at: 1, sessionId: 'a' })
    expect(reportOf({ state: 'sleeping', at: 1, sessionId: 'a' })).toBeNull()
  })

  test('each issue keeps its last five records; the dropped ones are named', async () => {
    let records = {}
    let dropped: string[] = []
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) ({ records, dropped } = withRecord(records, 3, record(id)))

    expect((records as Record<string, SessionRecord[]>)['3']?.map(one => one.sessionId)).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(dropped).toEqual(['a'])
  })

  test('a resume gives the record its new tab and time', async () => {
    const records = { '3': [record('a'), record('b')] }
    const reopened = withReopened(records, 3, 'a', { app: 'iterm', id: 'X' }, NOW)

    expect(reopened['3']?.[0]).toEqual({ sessionId: 'a', terminal: { app: 'iterm', id: 'X' }, startedAt: NOW })
    expect(reopened['3']?.[1]).toEqual(record('b'))
  })
})

describe('session state', () => {
  test('a session starts until it reports, then says where it stands until it falls silent', async () => {
    expect(stateOf(record('a', NOW - 10_000), null, NOW)).toBe('starting')
    expect(stateOf(record('a', NOW - 60_000), null, NOW)).toBe('ended')
    expect(stateOf(record('a'), report('working'), NOW)).toBe('working')
    expect(stateOf(record('a'), report('waiting'), NOW)).toBe('waiting')
    expect(stateOf(record('a'), report('ended'), NOW)).toBe('ended')
    expect(stateOf(record('a'), report('working', NOW - 30_000), NOW)).toBe('ended')
    // A report from before a resume says nothing of the resumed run.
    expect(stateOf(record('a', NOW - 1_000), report('ended', NOW - 5_000), NOW)).toBe('starting')
  })

  test('the issue shows the session that needs the person first, and resumes the last one by its id now', async () => {
    const list = [record('a'), record('b'), record('c')]
    const reports = new Map([
      ['a', report('waiting', NOW - 5_000, 'a')],
      ['b', report('working', NOW - 5_000, 'b')],
      ['c', report('ended', NOW - 5_000, 'c2')],
    ])
    const session = issueSessionOf(list, reports, NOW)

    expect(session?.state).toBe('waiting')
    expect(session?.live?.sessionId).toBe('a')
    expect(session?.last.sessionId).toBe('c')
    // `c` moved to `c2` with a /clear.
    expect(session?.resumeId).toBe('c2')
    expect(issueSessionOf([record('a')], new Map(), NOW)).toEqual({
      state: 'ended',
      live: null,
      last: record('a'),
      resumeId: 'a',
    })
    expect(issueSessionOf([], new Map(), NOW)).toBeNull()
  })
})
