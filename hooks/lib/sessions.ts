// Session tracking (spec section 8): the records the board keeps of the
// sessions it started, the reports those sessions write of themselves, and
// what the two say of each issue. Pure: no `$`, so the tests run it directly.
//
// Both live in the plugin's `$.store`, one JSON file the engine reads again on
// each get and locks for each set, so concurrent sessions share it. Each key
// has one writer: `sessions:<owner/repo>` the board, `live:<record id>` the
// session the record names.

import type { SessionState } from '../../types'

/**
 * The environment variable a started session finds its record id in: the
 * board puts it before `claude` in the tab's command. The reporter reads it
 * with `$.env.get`, which takes a literal, so `register.tsx` spells it again.
 */
export const SESSION_ENV = 'KANBAN_BOARD_SESSION'
/** How often a tracked session writes its state again. */
export const HEARTBEAT_MS = 10_000
/** A report older than this reads as ended: the session died without saying so. */
export const STALE_MS = 30_000
/** A session with no report yet reads as starting this long after the board started it. */
export const STARTING_MS = 60_000
/** The records kept per issue: the last few are enough to resume. */
export const RECORDS_PER_ISSUE = 5

/** The tab a session runs in: Orca's terminal handle, or iTerm's session id. */
export type Terminal = { app: 'orca' | 'iterm'; id: string }

/**
 * A session the board started. `sessionId` is the id the board gave it, which
 * also names its report; a `/clear` in the session moves it to a new id, which
 * the report carries. `startedAt` is when the board last opened its tab.
 */
export type SessionRecord = { sessionId: string; terminal: Terminal | null; startedAt: number }

/** The records of one repository by issue number. */
export type Records = Record<string, SessionRecord[]>

/** What a tracked session writes of itself under `live:<record id>`. */
export type Report = { state: 'working' | 'waiting' | 'ended'; at: number; sessionId: string }

export const recordsKey = (repo: string) => `sessions:${repo}`
export const reportKey = (recordId: string) => `live:${recordId}`

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function terminalOf(value: unknown): Terminal | null {
  // Stage 4 kept Orca's handle as a bare string, and null for iTerm.
  if (typeof value === 'string') return { app: 'orca', id: value }
  if (!isObject(value) || typeof value.id !== 'string') return null
  return value.app === 'orca' || value.app === 'iterm' ? { app: value.app, id: value.id } : null
}

/** The records as the store holds them; anything malformed is left out. */
export function recordsOf(stored: unknown): Records {
  const records: Records = {}
  if (!isObject(stored)) return records
  for (const [number, list] of Object.entries(stored)) {
    if (!Array.isArray(list)) continue
    const kept = list.flatMap((one: unknown): SessionRecord[] =>
      isObject(one) && typeof one.sessionId === 'string' && typeof one.startedAt === 'number'
        ? [{ sessionId: one.sessionId, terminal: terminalOf(one.terminal), startedAt: one.startedAt }]
        : [],
    )
    if (kept.length > 0) records[number] = kept
  }
  return records
}

export function reportOf(stored: unknown): Report | null {
  if (!isObject(stored) || typeof stored.at !== 'number' || typeof stored.sessionId !== 'string') return null
  const { state } = stored
  return state === 'working' || state === 'waiting' || state === 'ended'
    ? { state, at: stored.at, sessionId: stored.sessionId }
    : null
}

/** The records with `record` added last for the issue, and the record ids that fell off the end. */
export function withRecord(records: Records, number: number, record: SessionRecord): { records: Records; dropped: string[] } {
  const list = [...(records[String(number)] ?? []), record]
  const cut = Math.max(0, list.length - RECORDS_PER_ISSUE)
  return {
    records: { ...records, [String(number)]: list.slice(cut) },
    dropped: list.slice(0, cut).map(one => one.sessionId),
  }
}

/**
 * The records with the issue's session `sessionId` opened again at `at` in a
 * new tab: a resume. Its report until then is older than `at`, so the session
 * reads as starting until it reports again.
 */
export function withReopened(records: Records, number: number, sessionId: string, terminal: Terminal | null, at: number): Records {
  const list = records[String(number)]
  if (list === undefined) return records
  return {
    ...records,
    [String(number)]: list.map(one => (one.sessionId === sessionId ? { ...one, terminal, startedAt: at } : one)),
  }
}

/** Where a session stands now, from its last report, or from its start while it has none. */
export function stateOf(record: SessionRecord, report: Report | null, now: number): SessionState {
  // A report from before the board last opened its tab says nothing of this run.
  if (report === null || report.at < record.startedAt) return now - record.startedAt < STARTING_MS ? 'starting' : 'ended'
  if (report.state === 'ended' || now - report.at >= STALE_MS) return 'ended'
  return report.state
}

/** The one that needs the person first: waiting, then working, starting, ended. */
const RANK: Record<SessionState, number> = { waiting: 0, working: 1, starting: 2, ended: 3 }

/**
 * What the board says of an issue's sessions: the state of the one that
 * needs the person first, that session while it runs (to focus its tab), and
 * the id `claude --resume` takes for the last one.
 */
export type IssueSession = {
  state: SessionState
  live: SessionRecord | null
  last: SessionRecord
  resumeId: string
}

export function issueSessionOf(
  list: readonly SessionRecord[],
  reports: ReadonlyMap<string, Report>,
  now: number,
): IssueSession | null {
  const last = list.at(-1)
  if (last === undefined) return null
  let state: SessionState = 'ended'
  let live: SessionRecord | null = null
  // The newest first, so of two equal sessions the newer one is focused.
  for (const one of [...list].reverse()) {
    const current = stateOf(one, reports.get(one.sessionId) ?? null, now)
    if (RANK[current] < RANK[state]) {
      state = current
      live = one
    }
  }
  return { state, live, last, resumeId: reports.get(last.sessionId)?.sessionId ?? last.sessionId }
}
