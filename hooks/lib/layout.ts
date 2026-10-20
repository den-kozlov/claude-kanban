// Where every card of the board goes, in cells: the columns side by side or
// stacked as sections, which cards collapse to one-line rows, and the window
// each column scrolls to (spec sections 2 and 3). Pure, so the board's
// surface module draws from it and the tests check it without a surface.

import type { Card, ColumnId } from '../../types'
import type { ViewColumn } from './model'
import { cellWidth, oneLine, truncate, wrap } from './text'

/** The narrowest a column with cards may be before the board stacks. */
export const MIN_COLUMN_WIDTH = 22
export const COLUMN_GAP = 1
/** The status bar above the board. */
export const TOP_ROWS = 1
/** A side-by-side column's title and rule. */
export const HEADER_ROWS = 2
/** The selection mark and its space in front of every card line. */
export const GUTTER = 2
const TITLE_LINES = 2

export type Tone = 'plain' | 'dim' | 'success' | 'failure' | 'pending'

export type Segment = { text: string; tone: Tone }

export type CardLines = { title: string[]; meta: Segment[] }

const CI_MARK = { success: '✓', failure: '✗', pending: '•' } as const

const PRIORITY_TONE = { Urgent: 'failure', High: 'pending', Medium: 'plain', Low: 'dim' } as const

/** The lines of a full card `width` cells wide (gutter excluded). */
export function fullCard(card: Card, width: number): CardLines {
  const title = wrap(`#${card.number} ${oneLine(card.title)}`, width, TITLE_LINES)
  const parts: Segment[] = []
  if (card.priority !== null) parts.push({ text: card.priority, tone: PRIORITY_TONE[card.priority] })
  if (card.pr !== null) {
    const ci = card.pr.ci
    parts.push({
      text: `${card.pr.isDraft ? 'draft ' : ''}PR #${card.pr.number}${ci === null ? '' : ` ${CI_MARK[ci]}`}`,
      tone: ci ?? 'dim',
    })
  }
  if (card.isSandcastle) parts.push({ text: 'sandcastle', tone: 'pending' })
  for (const label of card.labels) parts.push({ text: label, tone: 'dim' })
  if (card.comments > 0) {
    parts.push({ text: `${card.comments} comment${card.comments === 1 ? '' : 's'}`, tone: 'dim' })
  }
  return { title, meta: fitSegments(parts, width) }
}

/** Segments joined by two spaces, cut where `width` ends. */
export function fitSegments(parts: Segment[], width: number): Segment[] {
  const fitted: Segment[] = []
  let used = 0
  for (const part of parts) {
    const gap = fitted.length === 0 ? 0 : 2
    const room = width - used - gap
    if (room <= 1) break
    const text = truncate(part.text, room)
    fitted.push({ text: gap === 0 ? text : `  ${text}`, tone: part.tone })
    used += gap + cellWidth(text)
    if (text !== part.text) break
  }
  return fitted
}

/** A collapsed card: `#N title` on one line. */
export function rowText(card: Card, width: number): string {
  return truncate(`#${card.number} ${oneLine(card.title)}`, width)
}

/** Rows a full card takes: its title, its meta line, a blank row after it. */
export function fullHeight(card: Card, width: number): number {
  const lines = fullCard(card, width)
  return lines.title.length + (lines.meta.length > 0 ? 1 : 0) + 1
}

export type HeaderEntry = { kind: 'header'; id: ColumnId; title: string; count: number; top: number }

export type CardEntry = { kind: 'card'; card: Card; isFull: boolean; top: number; height: number }

export type Entry = HeaderEntry | CardEntry

export type Section = {
  /** What the board's scroll state keys this section's window by. */
  key: string
  x: number
  width: number
  /** A side-by-side column's fixed title; null in the stacked layout. */
  header: { id: ColumnId; title: string; count: number } | null
  /** The first row under the header, where `↑ n more` goes while scrolled. */
  bodyTop: number
  bodyRows: number
  /** The entries in view, each at its row of the board. */
  entries: Entry[]
  isScrolled: boolean
  /** The index of the first entry in view among all of the section's entries. */
  start: number
  above: number
  below: number
}

export type Layout = {
  mode: 'side' | 'stack'
  sections: Section[]
  /** Card numbers per column, left to right: what the arrows walk. */
  order: number[][]
}

type Slot = { kind: 'header'; header: Omit<HeaderEntry, 'kind' | 'top'> } | { kind: 'card'; card: Card }

type Sized = { slot: Slot; isFull: boolean; height: number }

/**
 * Collapses cards from the end until the slots fit `rows`, never the
 * selected one; when even rows do not fit, picks the window to show from
 * `start` on so that the selection stays in view.
 */
export function fitSlots(
  slots: Slot[],
  width: number,
  rows: number,
  selected: number | null,
  start: number,
): { sized: Sized[]; isScrolled: boolean; start: number; end: number } {
  const isSelected = (slot: Slot) => slot.kind === 'card' && slot.card.number === selected
  const sized: Sized[] = slots.map(slot => ({
    slot,
    isFull: slot.kind === 'card',
    height: slot.kind === 'card' ? fullHeight(slot.card, width - GUTTER) : 1,
  }))
  let total = sized.reduce((sum, one) => sum + one.height, 0)
  for (let index = sized.length - 1; index >= 0 && total > rows; index -= 1) {
    const one = sized[index] as Sized
    if (!one.isFull || isSelected(one.slot)) continue
    total -= one.height - 1
    one.isFull = false
    one.height = 1
  }
  if (total <= rows) return { sized, isScrolled: false, start: 0, end: sized.length }

  // A row each for `↑ n more` and `↓ n more`.
  const room = Math.max(1, rows - 2)
  const heightOf = (from: number, to: number) =>
    sized.slice(from, to).reduce((sum, one) => sum + one.height, 0)
  const last = sized.length - 1
  let first = Math.min(Math.max(0, start), last)
  const at = sized.findIndex(one => isSelected(one.slot))
  if (at >= 0) {
    if (at < first) first = at
    while (first < at && heightOf(first, at + 1) > room) first += 1
  }
  // No empty rows under the last entry while entries above are hidden.
  while (first > 0 && heightOf(first - 1, sized.length) <= room) first -= 1
  let end = first
  while (end < sized.length && heightOf(first, end + 1) <= room) end += 1
  if (end === first) end = first + 1
  return { sized, isScrolled: true, start: first, end }
}

function section(
  key: string,
  x: number,
  width: number,
  header: Section['header'],
  bodyTop: number,
  bodyRows: number,
  slots: Slot[],
  selected: number | null,
  start: number,
): Section {
  const fit = fitSlots(slots, width, bodyRows, selected, start)
  const countCards = (list: Sized[]) => list.filter(one => one.slot.kind === 'card').length
  const entries: Entry[] = []
  let top = bodyTop + (fit.isScrolled ? 1 : 0)
  for (const one of fit.sized.slice(fit.start, fit.end)) {
    entries.push(
      one.slot.kind === 'header'
        ? { kind: 'header', ...one.slot.header, top }
        : { kind: 'card', card: one.slot.card, isFull: one.isFull, top, height: one.height },
    )
    top += one.height
  }
  return {
    key,
    x,
    width,
    header,
    bodyTop,
    bodyRows,
    entries,
    isScrolled: fit.isScrolled,
    start: fit.start,
    above: countCards(fit.sized.slice(0, fit.start)),
    below: countCards(fit.sized.slice(fit.end)),
  }
}

/** The width of a column with no cards: its title and a space each side. */
const emptyWidth = (column: ViewColumn) => cellWidth(column.title) + 2

/**
 * Lays the columns out in `columns` × `rows` cells: side by side while each
 * column with cards gets `MIN_COLUMN_WIDTH`, else stacked as sections.
 */
export function layoutBoard(
  view: ViewColumn[],
  size: { columns: number; rows: number },
  selected: number | null,
  scroll: Readonly<Record<string, number>>,
): Layout {
  const order = view.map(column => column.cards.map(card => card.number))
  const filled = view.filter(column => column.cards.length > 0)
  const gaps = Math.max(0, view.length - 1) * COLUMN_GAP
  const fixed = view.filter(column => column.cards.length === 0).reduce((sum, c) => sum + emptyWidth(c), 0)
  const share = filled.length === 0 ? 0 : Math.floor((size.columns - fixed - gaps) / filled.length)

  if (filled.length > 0 && share < MIN_COLUMN_WIDTH) {
    const slots: Slot[] = view.flatMap(column => [
      { kind: 'header', header: { id: column.id, title: column.title, count: column.cards.length } } as Slot,
      ...column.cards.map(card => ({ kind: 'card', card }) as Slot),
    ])
    const rows = size.rows - TOP_ROWS
    return {
      mode: 'stack',
      order,
      sections: [section('stack', 0, size.columns, null, TOP_ROWS, rows, slots, selected, scroll.stack ?? 0)],
    }
  }

  let spare = filled.length === 0 ? 0 : size.columns - fixed - gaps - share * filled.length
  let x = 0
  const sections = view.map(column => {
    const isEmpty = column.cards.length === 0
    let width = isEmpty ? emptyWidth(column) : share
    if (!isEmpty && spare > 0) {
      width += 1
      spare -= 1
    }
    const bodyTop = TOP_ROWS + HEADER_ROWS
    const one = section(
      column.id,
      x,
      width,
      { id: column.id, title: column.title, count: column.cards.length },
      bodyTop,
      size.rows - bodyTop,
      column.cards.map(card => ({ kind: 'card', card })),
      selected,
      scroll[column.id] ?? 0,
    )
    x += width + COLUMN_GAP
    return one
  })
  return { mode: 'side', order, sections }
}

/** The windows the layout settled on, to keep as the board's scroll state. */
export function scrollOf(layout: Layout): Record<string, number> {
  return Object.fromEntries(layout.sections.map(one => [one.key, one.start]))
}

/** The selection, or the first card when it is gone from the board. */
export function resolveSelection(order: number[][], selected: number | null): number | null {
  if (selected !== null && order.some(column => column.includes(selected))) return selected
  return order.find(column => column.length > 0)?.[0] ?? null
}

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Where an arrow moves the selection. */
export function move(layout: Layout, selected: number | null, direction: Direction): number | null {
  const { order } = layout
  const current = resolveSelection(order, selected)
  if (current === null) return null
  const column = order.findIndex(numbers => numbers.includes(current))
  const numbers = order[column] as number[]
  const index = numbers.indexOf(current)

  if (direction === 'up' || direction === 'down') {
    if (layout.mode === 'stack') {
      const flat = order.flat()
      const at = flat.indexOf(current) + (direction === 'up' ? -1 : 1)
      return flat[Math.min(Math.max(0, at), flat.length - 1)] ?? current
    }
    const at = index + (direction === 'up' ? -1 : 1)
    return numbers[Math.min(Math.max(0, at), numbers.length - 1)] ?? current
  }

  const step = direction === 'left' ? -1 : 1
  for (let other = column + step; other >= 0 && other < order.length; other += step) {
    const target = order[other] as number[]
    if (target.length > 0) return target[Math.min(index, target.length - 1)] ?? current
  }
  return current
}

/** The card under a cell of the board, if any. */
export function hitTest(layout: Layout, x: number, y: number): number | null {
  for (const one of layout.sections) {
    if (x < one.x || x >= one.x + one.width) continue
    for (const entry of one.entries) {
      const height = entry.kind === 'card' ? entry.height : 1
      if (entry.kind === 'card' && y >= entry.top && y < entry.top + height) return entry.card.number
    }
  }
  return null
}
