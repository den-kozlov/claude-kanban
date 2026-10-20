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
}

/** An issue labelled `prd`, `ideas` or `wayfinder:map`: a filter, never a card. */
export type Container = { number: number; title: string }

export type Board = {
  repo: string
  cards: Card[]
  containers: Container[]
  updatedAt: number
}

export type BoardStatus = {
  isLoading: boolean
  /** The last refresh's failure; the board keeps the last good data. */
  error: string | null
}

/**
 * A card the board should select, asked from outside the board (a link in the
 * detail popup). `seq` grows with each ask, so the board takes each one once.
 */
export type SelectRequest = { number: number; seq: number }

/** What the pane hands the board's `Client` (hooks/board.tsx). */
export type BoardProps = {
  board: Board | null
  status: BoardStatus
  pick: SelectRequest | null
  isFocused: boolean
  columns: number
  rows: number
}

/** What the board's `Client` posts to the hooks module. */
export type BoardMessage =
  | { type: 'refresh' }
  | { type: 'open'; number: number }
  | { type: 'detail'; number: number }

/** A blocker or the parent of an issue, as the detail popup links it. */
export type IssueLink = { number: number; title: string; isOpen: boolean }

export type IssueComment = { author: string; createdAt: string; body: string }

/** What the detail popup shows of one issue (spec section 5). */
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
  /** Markdown, cut to a size the pane draws whole. */
  body: string
  /** The last three, oldest first. */
  comments: IssueComment[]
  commentCount: number
}

/** The detail popup's issue: the one asked for, and where its load stands. */
export type Detail = {
  number: number
  issue: IssueDetail | null
  isLoading: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'kanban-board': { board: Board | null; status: BoardStatus; pick: SelectRequest | null; detail: Detail | null }
  }
}
