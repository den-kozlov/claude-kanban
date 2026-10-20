// From GitHub's answer for one issue to what the detail view shows (spec
// section 5). Pure: no `$`, so the tests run it directly.

import type { IssueComment, IssueDetail, IssueLink } from '../../types'
import { priorityOf, type RawFieldValue } from './model'
import { oneLine } from './text'

/**
 * The board's props carry the issue beside the board, all under 100,000
 * characters: the body and three comments take 16,000 at most.
 */
export const BODY_LIMIT = 10_000
export const COMMENT_LIMIT = 2_000
const TITLE_LIMIT = 200

type RawLink = { number: number; title: string; state: string }

export type RawIssueDetail = {
  id: string
  number: number
  title: string
  url: string
  state: string
  body: string | null
  labels: { nodes: { name: string }[] }
  assignees: { nodes: { login: string }[] }
  blockedBy?: { nodes: RawLink[] }
  parent: RawLink | null
  issueFieldValues?: { nodes: RawFieldValue[] }
  comments: {
    totalCount: number
    nodes: { author: { login: string } | null; createdAt: string; body: string }[]
  }
}

/**
 * Markdown the detail view draws: tab and newline its only control characters, cut to
 * `limit` characters with a note, and a code fence the cut left open closed.
 */
export function markdownOf(text: string, limit: number): string {
  let clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  if (clean.length <= limit) return clean.trim()
  clean = clean.slice(0, limit)
  // Not half of a surrogate pair at the cut.
  if (/[\ud800-\udbff]$/.test(clean)) clean = clean.slice(0, -1)
  const fences = clean.split('\n').filter(line => line.trimStart().startsWith('```')).length
  return `${clean.trimEnd()}${fences % 2 === 1 ? '\n```' : ''}\n\n*… cut here: open the issue in the browser for the rest.*`
}

const linkOf = (raw: RawLink): IssueLink => ({
  number: raw.number,
  title: oneLine(raw.title).slice(0, TITLE_LIMIT),
  isOpen: raw.state === 'OPEN',
})

export function detailOf(raw: RawIssueDetail): IssueDetail {
  const comments: IssueComment[] = raw.comments.nodes.map(comment => ({
    author: comment.author?.login ?? 'ghost',
    createdAt: comment.createdAt,
    body: markdownOf(comment.body, COMMENT_LIMIT),
  }))
  return {
    number: raw.number,
    title: oneLine(raw.title).slice(0, TITLE_LIMIT),
    url: raw.url,
    isOpen: raw.state === 'OPEN',
    labels: raw.labels.nodes.map(label => label.name),
    assignees: raw.assignees.nodes.map(user => user.login),
    priority: priorityOf(raw),
    // Open blockers first: they are what keeps the issue in Blocked.
    blockers: (raw.blockedBy?.nodes ?? []).map(linkOf).sort((a, b) => Number(b.isOpen) - Number(a.isOpen)),
    parent: raw.parent === null ? null : linkOf(raw.parent),
    body: markdownOf(raw.body ?? '', BODY_LIMIT),
    comments,
    commentCount: raw.comments.totalCount,
  }
}
