export type ColumnId =
  | 'blocked'
  | 'triage'
  | 'needsInfo'
  | 'readyForAgent'
  | 'readyForHuman'
  | 'inProgress'
  | 'review'
  | 'done'

export type Priority = 'Urgent' | 'High' | 'Medium' | 'Low'

export type CiState = 'success' | 'failure' | 'pending'

export type PrBadge = { number: number; isDraft: boolean; ci: CiState | null }

/**
 * Where a session the board started stands (spec section 8): starting until
 * it first reports, working through a turn, waiting for the person (the turn
 * ended, a permission prompt), ended (closed, or silent for 30 s).
 */
export type SessionState = 'starting' | 'working' | 'waiting' | 'ended'

/** What `s` does for a card: start a new session, focus the running one's tab, or resume the last one. */
export type StartAction = 'start' | 'focus' | 'resume'

export type Card = {
  number: number
  title: string
  column: ColumnId
  /** Up to three labels, container and column labels left out. */
  labels: string[]
  comments: number
  priority: Priority | null
  parent: number | null
  pr: PrBadge | null
  isSandcastle: boolean
  /** The state of its session that needs the person first; null when the board started none. */
  session: SessionState | null
  /** What `s` does; null when it does nothing, and `noStart` says why. */
  startAs: StartAction | null
  /** Why `s` does nothing (its column, no launch rule); null when it does something. */
  noStart: string | null
}

/** An issue labelled `prd`, `ideas` or `wayfinder:map`: a filter, never a card. */
export type Container = { number: number; title: string }

export type Board = {
  repo: string
  cards: Card[]
  containers: Container[]
  updatedAt: number
  /** Why `p`/`P` do nothing here (no `Priority` issue field, not read yet); null while they work. */
  priorityOff: string | null
}

export type BoardStatus = {
  isLoading: boolean
  /** The last refresh's failure; the board keeps the last good data. */
  error: string | null
}

/**
 * A card the board should select, asked by the hooks module (the issue the
 * detail view showed last). `seq` grows with each ask, so the board takes each one once.
 */
export type SelectRequest = { number: number; seq: number }

/** What the pane hands the board's `Client` (hooks/board.tsx). */
export type BoardProps = {
  board: Board | null
  status: BoardStatus
  pick: SelectRequest | null
  /** The issue the detail view shows; null while the board shows its columns. */
  detail: Detail | null
  columns: number
  rows: number
}

/** What the board's `Client` posts to the hooks module. */
export type BoardMessage =
  | { type: 'refresh' }
  | { type: 'open'; number: number }
  /** Shows the issue in the detail view (Enter, a link). */
  | { type: 'detail'; number: number }
  /** Closes the detail view (Backspace). */
  | { type: 'back' }
  /** `current`: the Priority the board shows for it, for an issue the board does not hold. */
  | { type: 'priority'; number: number; action: PriorityAction; current: Priority | null }
  | { type: 'start'; number: number }

/** `p` moves to the next Priority (none → Urgent → … → Low → none), `P` clears it. */
export type PriorityAction = 'cycle' | 'clear'

/** A blocker or the parent of an issue, as the detail view links it. */
export type IssueLink = { number: number; title: string; isOpen: boolean }

export type IssueComment = { author: string; createdAt: string; body: string }

/** What the detail view shows of one issue (spec section 5). */
export type IssueDetail = {
  number: number
  title: string
  url: string
  isOpen: boolean
  labels: string[]
  assignees: string[]
  priority: Priority | null
  blockers: IssueLink[]
  parent: IssueLink | null
  /** Markdown, cut to a size the board's props carry beside the board. */
  body: string
  /** The last three, oldest first. */
  comments: IssueComment[]
  commentCount: number
}

/** The detail view's issue: the one asked for, and where its load stands. */
export type Detail = {
  number: number
  issue: IssueDetail | null
  isLoading: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'kanban-board': {
      /** Kept under a shape tag: a reload whose `Card` or `Board` changed reads the old one as absent. */
      board: Shaped<Board | null>
      status: BoardStatus
      pick: SelectRequest | null
      detail: Detail | null
    }
  }
}
