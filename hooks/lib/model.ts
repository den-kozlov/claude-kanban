// From GitHub's issues and pull requests and the local branches to the
// board's cards: the column rules (spec section 2) and the order (section 3).
// Pure: no `$`, so the tests run it directly.

import type { Board, Card, CiState, ColumnId, Container, PrBadge, Priority } from '../../types'
import { oneLine } from './text'

/** Titles are cut so the board stays well under a `Client`'s 100,000 characters of props. */
const TITLE_LIMIT = 200

export type Config = {
  columns: {
    triage: string[]
    needsInfo: string[]
    readyForAgent: string[]
    readyForHuman: string[]
  }
  containers: string[]
  branchPatterns: { issue: string; fallback: string; sandcastle: string }
  doneDays: number
  refreshSeconds: number
}

export const DEFAULT_CONFIG: Config = {
  columns: {
    triage: ['needs-triage'],
    needsInfo: ['needs-info'],
    readyForAgent: ['ready-for-agent'],
    readyForHuman: ['ready-for-human'],
  },
  containers: ['prd', 'ideas', 'wayfinder:map'],
  branchPatterns: {
    issue: 'issue-(\\d+)',
    fallback: '-(\\d+)$',
    sandcastle: '^sandcastle/issue-(\\d+)$',
  },
  doneDays: 7,
  refreshSeconds: 60,
}

/** The columns left to right. */
export const COLUMNS: readonly { id: ColumnId; title: string }[] = [
  { id: 'blocked', title: 'Blocked' },
  { id: 'triage', title: 'Triage' },
  { id: 'needsInfo', title: 'Needs info' },
  { id: 'readyForAgent', title: 'Ready for agent' },
  { id: 'readyForHuman', title: 'Ready for human' },
  { id: 'inProgress', title: 'In progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
]

/** The label columns in their order of precedence. */
const LABEL_COLUMNS = ['triage', 'needsInfo', 'readyForAgent', 'readyForHuman'] as const

export const PRIORITIES: readonly Priority[] = ['Urgent', 'High', 'Medium', 'Low']

export type RawIssue = {
  number: number
  title: string
  labels: { nodes: { name: string }[] }
  comments: { totalCount: number }
  parent: { number: number } | null
  blockedBy?: { nodes: { number: number; state: string }[] }
  issueFieldValues?: { nodes: RawFieldValue[] }
  closedByPullRequestsReferences?: { nodes: { number: number; state: string; isDraft: boolean }[] }
}

export type RawFieldValue = {
  __typename?: string
  name?: string
  field?: { name?: string } | null
}

export type RawPr = {
  number: number
  headRefName: string
  body: string
  isDraft: boolean
  statusCheckRollup: { state: string } | null
}

export type Snapshot = {
  repo: string
  open: RawIssue[]
  done: RawIssue[]
  prs: RawPr[]
}

const labelsOf = (issue: RawIssue) => issue.labels.nodes.map(label => label.name)

export function priorityOf(issue: RawIssue): Priority | null {
  for (const value of issue.issueFieldValues?.nodes ?? []) {
    if (value.field?.name !== 'Priority') continue
    const name = PRIORITIES.find(one => one === value.name)
    if (name !== undefined) return name
  }
  return null
}

const rank = (priority: Priority | null) =>
  priority === null ? PRIORITIES.length : PRIORITIES.indexOf(priority)

/** Priority (Urgent first, none last), then number ascending. */
export function compareCards(a: Card, b: Card): number {
  return rank(a.priority) - rank(b.priority) || a.number - b.number
}

export function ciOf(rollup: RawPr['statusCheckRollup']): CiState | null {
  switch (rollup?.state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return null
  }
}

const numberIn = (pattern: RegExp, text: string): number | null => {
  const match = pattern.exec(text)
  return match?.[1] === undefined ? null : Number(match[1])
}

/**
 * The open PRs by the issue they are for: `issue-<N>` in the head branch, else
 * `-<N>` at its end, else every `#N` in the body. The newest PR wins.
 */
export function prsByIssue(prs: RawPr[], config: Config): Map<number, PrBadge> {
  const issuePattern = new RegExp(config.branchPatterns.issue)
  const fallbackPattern = new RegExp(config.branchPatterns.fallback)
  const byIssue = new Map<number, PrBadge>()
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const badge: PrBadge = { number: pr.number, isDraft: pr.isDraft, ci: ciOf(pr.statusCheckRollup) }
    const fromBranch =
      numberIn(issuePattern, pr.headRefName) ?? numberIn(fallbackPattern, pr.headRefName)
    const issues =
      fromBranch !== null
        ? [fromBranch]
        : [...(pr.body ?? '').matchAll(/(?<![\w/#])#(\d+)\b/g)].map(match => Number(match[1]))
    for (const issue of issues) byIssue.set(issue, badge)
  }
  return byIssue
}

/**
 * Local and remote branch names (no `origin/` prefix) by the issue they work
 * on: `issue-<N>` anywhere, or a Sandcastle branch `sandcastle/issue-<N>`.
 */
export function branchesByIssue(branches: string[], config: Config): Map<number, { isSandcastle: boolean }> {
  const issuePattern = new RegExp(config.branchPatterns.issue)
  const sandcastlePattern = new RegExp(config.branchPatterns.sandcastle)
  const byIssue = new Map<number, { isSandcastle: boolean }>()
  for (const branch of branches) {
    const sandcastle = numberIn(sandcastlePattern, branch)
    if (sandcastle !== null) {
      byIssue.set(sandcastle, { isSandcastle: true })
      continue
    }
    const issue = numberIn(issuePattern, branch)
    if (issue !== null && !byIssue.has(issue)) byIssue.set(issue, { isSandcastle: false })
  }
  return byIssue
}

const isContainer = (issue: RawIssue, config: Config) =>
  labelsOf(issue).some(label => config.containers.includes(label))

/** The first column whose rule matches: Review, In progress, Blocked, the label columns. */
function columnOf(
  issue: RawIssue,
  config: Config,
  pr: PrBadge | null,
  isInProgress: boolean,
): ColumnId {
  if (pr !== null) return 'review'
  if (isInProgress) return 'inProgress'
  if ((issue.blockedBy?.nodes ?? []).some(blocker => blocker.state === 'OPEN')) return 'blocked'
  const labels = labelsOf(issue)
  return LABEL_COLUMNS.find(id => config.columns[id].some(label => labels.includes(label))) ?? 'triage'
}

function cardOf(issue: RawIssue, column: ColumnId, config: Config): Omit<Card, 'pr' | 'isSandcastle'> {
  const hidden = new Set([...config.containers, ...Object.values(config.columns).flat()])
  return {
    number: issue.number,
    title: oneLine(issue.title).slice(0, TITLE_LIMIT),
    column,
    labels: labelsOf(issue)
      .filter(label => !hidden.has(label))
      .slice(0, 3),
    comments: issue.comments.totalCount,
    priority: priorityOf(issue),
    parent: issue.parent?.number ?? null,
  }
}

export function buildBoard(
  snapshot: Snapshot,
  branches: string[],
  config: Config,
  updatedAt: number,
): Board {
  const prs = prsByIssue(snapshot.prs, config)
  const inProgress = branchesByIssue(branches, config)
  const containers: Container[] = []
  const cards: Card[] = []

  for (const issue of snapshot.done) {
    if (isContainer(issue, config)) continue
    cards.push({ ...cardOf(issue, 'done', config), pr: null, isSandcastle: false })
  }

  for (const issue of snapshot.open) {
    if (isContainer(issue, config)) {
      containers.push({ number: issue.number, title: oneLine(issue.title).slice(0, TITLE_LIMIT) })
      continue
    }
    const linked = (issue.closedByPullRequestsReferences?.nodes ?? []).find(pr => pr.state === 'OPEN')
    const pr =
      prs.get(issue.number) ??
      (linked === undefined ? null : { number: linked.number, isDraft: linked.isDraft, ci: null })
    const branch = inProgress.get(issue.number)
    const column = columnOf(issue, config, pr, branch !== undefined)
    cards.push({ ...cardOf(issue, column, config), pr, isSandcastle: branch?.isSandcastle === true })
  }

  containers.sort((a, b) => a.number - b.number)
  cards.sort(compareCards)
  return { repo: snapshot.repo, cards, containers, updatedAt }
}

export type ViewOptions = { showDone: boolean; filter: number | null }

export type ViewColumn = { id: ColumnId; title: string; cards: Card[] }

/** The columns the board shows, left to right, each in card order. */
export function viewColumns(board: Board, options: ViewOptions): ViewColumn[] {
  const cards = board.cards.filter(card => options.filter === null || card.parent === options.filter)
  return COLUMNS.filter(column => column.id !== 'done' || options.showDone).map(column => ({
    ...column,
    cards: cards.filter(card => card.column === column.id).sort(compareCards),
  }))
}
