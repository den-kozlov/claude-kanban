// The detail view (spec section 5): one issue drawn inside the board's pane,
// line by line and cut to the cell, so the board scrolls it and walks its links
// with the keys it already holds. Pure: the tests check it without a surface.

import type { Board, Detail, IssueDetail, IssueLink, SessionState, StartAction } from '../../types'
import { SESSION_LABEL, type Segment } from './layout'
import { COLUMNS } from './model'
import { cellWidth, pad, truncate, wrap } from './text'

/** One row of the view; `link` is the issue a press on it (or Enter on it) shows. */
export type DetailLine = { parts: Segment[]; isBold: boolean; link: number | null }

/** Where the issue stands on the board, and what `s` and `p` do for it there. */
export type DetailPlace = {
  /** The column's title; null when the issue is not a card on the board. */
  column: string | null
  session: SessionState | null
  priorityOff: string | null
  startAs: StartAction | null
  startOff: string | null
}

const LABEL_WIDTH = 11
const TAB = '    '
const MAX_LINES = Number.MAX_SAFE_INTEGER

export const START_LABEL: Record<StartAction, string> = { start: 'start', focus: 'focus session', resume: 'resume session' }

export function placeOf(board: Board | null, number: number): DetailPlace {
  const card = board?.cards.find(one => one.number === number)
  return {
    column: COLUMNS.find(one => one.id === card?.column)?.title ?? null,
    session: card?.session ?? null,
    priorityOff: board === null ? 'Priority is not read yet' : board.priorityOff,
    startAs: card?.startAs ?? null,
    startOff: card === undefined ? 'only a card on the board starts' : card.noStart,
  }
}

const line = (parts: Segment[], isBold = false, link: number | null = null): DetailLine => ({ parts, isBold, link })
const plain = (text: string, isBold = false): DetailLine => line([{ text, tone: 'plain' }], isBold)
const dim = (text: string): DetailLine => line([{ text, tone: 'dim' }])
const blank = (): DetailLine => plain('')

/**
 * Markdown as plain lines `width` cells wide: each source line wrapped at
 * words, its indent kept (a code block stays readable), tabs as four spaces.
 */
export function textLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const source of text.replace(/\t/g, TAB).split('\n')) {
    const indent = Math.min(source.length - source.trimStart().length, Math.floor(width / 2))
    const rest = source.trim()
    if (rest === '') {
      out.push('')
      continue
    }
    for (const part of wrap(rest, Math.max(1, width - indent), MAX_LINES)) out.push(' '.repeat(indent) + part)
  }
  return out
}

/** `Label      value`, the value cut to the width left. */
function field(name: string, value: Segment[], width: number, link: number | null = null): DetailLine {
  let room = width - LABEL_WIDTH
  const parts: Segment[] = [{ text: pad(name, LABEL_WIDTH), tone: 'dim' }]
  for (const part of value) {
    if (room <= 0) break
    const text = truncate(part.text, room)
    parts.push({ text, tone: part.tone })
    room -= cellWidth(text)
  }
  return line(parts, false, link)
}

const linkParts = (one: IssueLink): Segment[] => [
  { text: `#${one.number} ${one.title}`, tone: 'plain' },
  { text: one.isOpen ? '  open' : '  closed', tone: 'dim' },
]

function issueLines(issue: IssueDetail, place: DetailPlace, width: number): DetailLine[] {
  const facts = [
    issue.isOpen ? 'open' : 'closed',
    place.column,
    `Priority ${issue.priority ?? 'none'}`,
    place.session === null ? null : `session ${SESSION_LABEL[place.session]}`,
  ]
  const lines: DetailLine[] = [
    ...wrap(`#${issue.number} ${issue.title}`, width, 2).map(text => plain(text, true)),
    dim(truncate(facts.filter(fact => fact !== null).join(' · '), width)),
  ]
  if (place.startAs === null) lines.push(dim(truncate(`Start: ${place.startOff ?? 'the card does not start'}`, width)))
  lines.push(blank())
  const list = (items: string[]) => [{ text: items.length === 0 ? '—' : items.join(', '), tone: 'plain' as const }]
  lines.push(field('Labels', list(issue.labels), width))
  lines.push(field('Assignees', list(issue.assignees), width))
  lines.push(
    issue.parent === null
      ? field('Parent', list([]), width)
      : field('Parent', linkParts(issue.parent), width, issue.parent.number),
  )
  if (issue.blockers.length === 0) lines.push(field('Blockers', list([]), width))
  issue.blockers.forEach((one, index) => lines.push(field(index === 0 ? 'Blockers' : '', linkParts(one), width, one.number)))

  const rule = dim('─'.repeat(Math.max(1, Math.min(width, 80))))
  lines.push(blank(), rule)
  if (issue.body === '') lines.push(dim('No description.'))
  else lines.push(...textLines(issue.body, width).map(text => plain(text)))
  lines.push(rule)
  lines.push(
    plain(
      issue.commentCount === 0
        ? 'No comments'
        : issue.commentCount <= issue.comments.length
          ? `Comments ${issue.commentCount}`
          : `Comments ${issue.commentCount}, the last ${issue.comments.length}`,
      true,
    ),
  )
  for (const comment of issue.comments) {
    lines.push(blank(), line([{ text: truncate(`${comment.author} · ${comment.createdAt.slice(0, 10)}`, width), tone: 'accent' }]))
    if (comment.body === '') lines.push(dim('(empty)'))
    else lines.push(...textLines(comment.body, width).map(text => plain(text)))
  }
  return lines
}

/** Every line of the view, `width` cells wide: the issue, or where its load stands. */
export function detailLines(detail: Detail, place: DetailPlace, width: number): DetailLine[] {
  if (detail.issue !== null && detail.issue.number === detail.number) return issueLines(detail.issue, place, width)
  if (detail.error !== null) {
    return wrap(`Could not load #${detail.number}: ${detail.error}`, width, MAX_LINES).map(text =>
      line([{ text, tone: 'failure' }]),
    )
  }
  return [dim(`Loading #${detail.number}…`)]
}

/** The first line in view: as asked, kept inside the lines. */
export function clampScroll(scroll: number, lines: number, rows: number): number {
  return Math.max(0, Math.min(scroll, lines - rows))
}

/** The scroll that brings line `index` into a window of `rows` lines. */
export function scrollTo(scroll: number, index: number, rows: number): number {
  if (index < scroll) return index
  if (index >= scroll + rows) return index - rows + 1
  return scroll
}

/** Where the detail view stands: the lines with a link, the one chosen, the window. */
export type DetailWindow = { links: number[]; link: number | null; scroll: number; rows: number; lineCount: number }

/**
 * ↑ / ↓, as a text browser walks a page: to the next link on screen past the
 * chosen one (past the edge of the screen when the chosen one scrolled away),
 * else a line of scrolling. `link` null: the choice stays where it was.
 */
export function walk(view: DetailWindow, step: 1 | -1): { scroll: number; link: number | null } {
  const isOnScreen = (line: number) => line >= view.scroll && line < view.scroll + view.rows
  const chosen = view.link === null ? undefined : view.links[view.link]
  const from = chosen !== undefined && isOnScreen(chosen) ? chosen : step === 1 ? view.scroll - 1 : view.scroll + view.rows
  const order = view.links.map((line, index) => ({ line, index }))
  const next = (step === 1 ? order : order.reverse()).find(
    one => isOnScreen(one.line) && (step === 1 ? one.line > from : one.line < from),
  )
  if (next !== undefined) return { scroll: view.scroll, link: next.index }
  return { scroll: clampScroll(view.scroll + step, view.lineCount, view.rows), link: null }
}
