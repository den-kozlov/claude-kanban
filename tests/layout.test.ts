import { describe, expect, test } from 'claude-code/testing'

import {
  fullHeight,
  hitTest,
  layoutBoard,
  move,
  TOP_ROWS,
  HEADER_ROWS,
  type CardEntry,
  type Section,
} from '../hooks/lib/layout'
import type { ViewColumn } from '../hooks/lib/model'
import { wrap } from '../hooks/lib/text'
import { card } from './fixtures'

const column = (id: ViewColumn['id'], title: string, numbers: number[]): ViewColumn => ({
  id,
  title,
  cards: numbers.map(number => card(number, { column: id })),
})

const cardsOf = (section: Section) => section.entries.filter((entry): entry is CardEntry => entry.kind === 'card')

describe('collapse and scroll', () => {
  const triage = column('triage', 'Triage', [1, 2, 3, 4, 5, 6])
  // A full card here: one title line, no meta line, a blank row.
  const full = fullHeight(card(1), 40)

  test('every card is full while the column fits', async () => {
    const layout = layoutBoard([triage], { columns: 42, rows: TOP_ROWS + HEADER_ROWS + 6 * full }, null, {})

    expect(full).toBe(2)
    expect(cardsOf(layout.sections[0] as Section).every(entry => entry.isFull)).toBe(true)
  })

  test('cards collapse from the end, the selected one stays full', async () => {
    const layout = layoutBoard([triage], { columns: 42, rows: TOP_ROWS + HEADER_ROWS + 9 }, 6, {})
    const kinds = cardsOf(layout.sections[0] as Section).map(entry => (entry.isFull ? 'full' : 'row'))

    // 9 rows: the selected card (2), then from the end 5, 4 and 3 collapse to rows (1 each).
    expect(kinds).toEqual(['full', 'full', 'row', 'row', 'row', 'full'])
  })

  test('when even the rows do not fit, the column scrolls to the selection', async () => {
    const layout = layoutBoard([triage], { columns: 42, rows: TOP_ROWS + HEADER_ROWS + 4 }, 6, {})
    const one = layout.sections[0] as Section

    expect(one.isScrolled).toBe(true)
    expect(cardsOf(one).map(entry => entry.card.number)).toEqual([6])
    expect(one.above).toBe(5)
    expect(one.below).toBe(0)
  })
})

describe('layout', () => {
  const view = [
    column('blocked', 'Blocked', []),
    column('triage', 'Triage', [1, 2]),
    column('readyForAgent', 'Ready for agent', [3]),
  ]

  test('an empty column shrinks to its header; columns with cards share the rest', async () => {
    const layout = layoutBoard(view, { columns: 100, rows: 20 }, null, {})

    expect(layout.mode).toBe('side')
    expect(layout.sections.map(one => one.width)).toEqual([9, 45, 44])
  })

  test('a pane too narrow for the columns stacks them as sections', async () => {
    const layout = layoutBoard(view, { columns: 50, rows: 20 }, null, {})

    expect(layout.mode).toBe('stack')
    expect(layout.sections[0]?.entries.map(entry => (entry.kind === 'header' ? entry.title : entry.card.number))).toEqual(
      ['Blocked', 'Triage', 1, 2, 'Ready for agent', 3],
    )
  })

  test('the arrows walk the cards and skip empty columns', async () => {
    const layout = layoutBoard(view, { columns: 100, rows: 20 }, null, {})

    expect(move(layout, null, 'down')).toBe(2)
    expect(move(layout, 2, 'right')).toBe(3)
    expect(move(layout, 3, 'left')).toBe(1)
    expect(move(layout, 1, 'left')).toBe(1)
    expect(move(layout, 1, 'up')).toBe(1)
  })

  test('a click selects the card under it', async () => {
    const layout = layoutBoard(view, { columns: 100, rows: 20 }, null, {})
    const second = cardsOf(layout.sections[1] as Section)[1] as CardEntry

    expect(hitTest(layout, 15, second.top)).toBe(2)
    expect(hitTest(layout, 15, 0)).toBe(null)
  })
})

describe('text', () => {
  test('a title wraps to two lines and ends in an ellipsis when cut', async () => {
    expect(wrap('one two three four five', 9, 2)).toEqual(['one two', 'three fo…'])
  })
})
