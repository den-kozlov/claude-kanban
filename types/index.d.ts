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

/** What the pane hands the board's `Client` (hooks/board.tsx). */
export type BoardProps = {
  board: Board | null
  status: BoardStatus
  isFocused: boolean
  columns: number
  rows: number
}

/** What the board's `Client` posts to the hooks module. */
export type BoardMessage = { type: 'refresh' } | { type: 'open'; number: number }

declare module 'claude-code' {
  interface PluginState {
    'kanban-board': { board: Board | null; status: BoardStatus }
  }
}
