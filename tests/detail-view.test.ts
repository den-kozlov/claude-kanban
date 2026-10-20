import { describe, expect, test } from 'claude-code/testing'

import { clampScroll, detailLines, placeOf, scrollTo, textLines, walk } from '../hooks/lib/detail-view'
import type { IssueDetail } from '../types'

const ISSUE: IssueDetail = {
  number: 2,
  title: 'Fix the login',
  url: 'https://github.com/o/r/issues/2',
  isOpen: true,
  labels: [],
  assignees: [],
  priority: null,
  blockers: [
    { number: 3, title: 'Triage me', isOpen: true },
    { number: 4, title: 'Old one', isOpen: false },
  ],
  parent: { number: 5, title: 'The PRD', isOpen: true },
  body: '',
  comments: [],
  commentCount: 0,
}

const text = (line: { parts: { text: string }[] }) => line.parts.map(part => part.text).join('')

describe('detail view', () => {
  test('Markdown becomes lines cut to the width: words wrap, the indent and tabs stay', async () => {
    expect(textLines('one two three four\n\n    code();\n\tx', 10)).toEqual([
      'one two',
      'three four',
      '',
      '    code()',
      '    ;',
      '    x',
    ])
  })

  test('the parent and each blocker are links, in that order; a card that does not start says why', async () => {
    const place = placeOf(null, 2)
    const lines = detailLines({ number: 2, issue: ISSUE, isLoading: false, error: null }, place, 60)

    expect(lines.flatMap(line => (line.link === null ? [] : [line.link]))).toEqual([5, 3, 4])
    expect(lines.map(text)).toContain('Start: only a card on the board starts')
    expect(lines.map(text)).toContain('Blockers   #3 Triage me  open')
    expect(lines.map(text)).toContain('           #4 Old one  closed')
    expect(lines.every(line => line.parts.every(part => !part.text.includes('\n')))).toBe(true)
  })

  test('a load in flight or failed says so', async () => {
    expect(detailLines({ number: 7, issue: null, isLoading: true, error: null }, placeOf(null, 7), 40).map(text)).toEqual([
      'Loading #7…',
    ])
    expect(detailLines({ number: 7, issue: null, isLoading: false, error: 'HTTP 404' }, placeOf(null, 7), 40).map(text)).toEqual([
      'Could not load #7: HTTP 404',
    ])
  })

  test('the window stays on the lines and moves to the chosen link', async () => {
    expect(clampScroll(-3, 50, 10)).toBe(0)
    expect(clampScroll(45, 50, 10)).toBe(40)
    expect(clampScroll(5, 4, 10)).toBe(0)
    expect(scrollTo(10, 25, 10)).toBe(16)
    expect(scrollTo(10, 3, 10)).toBe(3)
    expect(scrollTo(10, 12, 10)).toBe(10)
  })

  test('↑ / ↓ go to the next link on screen, else scroll', async () => {
    // Links on lines 6, 7 and 40 of 50; ten rows in view.
    const view = { links: [6, 7, 40], link: 0, scroll: 0, rows: 10, lineCount: 50 }

    expect(walk(view, 1)).toEqual({ scroll: 0, link: 1 })
    expect(walk({ ...view, link: 1 }, 1)).toEqual({ scroll: 1, link: null })
    expect(walk({ ...view, link: 1 }, -1)).toEqual({ scroll: 0, link: 0 })
    expect(walk(view, -1)).toEqual({ scroll: 0, link: null })
    // The chosen link scrolled away: the first one on screen in the walk's direction.
    expect(walk({ ...view, link: 1, scroll: 31 }, 1)).toEqual({ scroll: 31, link: 2 })
    expect(walk({ ...view, link: 2, scroll: 0 }, -1)).toEqual({ scroll: 0, link: 1 })
    expect(walk({ ...view, link: 0, scroll: 20 }, 1)).toEqual({ scroll: 21, link: null })
    // The end of the text: nothing moves.
    expect(walk({ ...view, link: 2, scroll: 40 }, 1)).toEqual({ scroll: 40, link: null })
  })
})
