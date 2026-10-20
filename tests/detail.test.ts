import { describe, expect, test } from 'claude-code/testing'

import { detailOf, markdownOf, type RawIssueDetail } from '../hooks/lib/detail'

const raw = (extra: Partial<RawIssueDetail> = {}): RawIssueDetail => ({
  id: 'I_7',
  number: 7,
  title: 'A\ntitle',
  url: 'https://github.com/o/r/issues/7',
  state: 'CLOSED',
  body: null,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  parent: null,
  comments: { totalCount: 0, nodes: [] },
  ...extra,
})

describe('detail', () => {
  test('the detail view gets one-line titles, open blockers first and the Priority', async () => {
    const detail = detailOf(
      raw({
        blockedBy: {
          nodes: [
            { number: 1, title: 'Done before', state: 'CLOSED' },
            { number: 2, title: 'Still open', state: 'OPEN' },
          ],
        },
        issueFieldValues: {
          nodes: [{ __typename: 'IssueFieldSingleSelectValue', name: 'Urgent', field: { name: 'Priority' } }],
        },
      }),
    )

    expect(detail.title).toBe('A title')
    expect(detail.isOpen).toBe(false)
    expect(detail.body).toBe('')
    expect(detail.priority).toBe('Urgent')
    expect(detail.blockers.map(one => [one.number, one.isOpen])).toEqual([
      [2, true],
      [1, false],
    ])
  })

  test('markdown keeps tabs and newlines, drops other control characters', async () => {
    expect(markdownOf('a\r\nb\u0007\tc\u001b[0m', 100)).toBe('a\nb\tc[0m')
  })

  test('a cut body ends in a note and closes the code fence it cut', async () => {
    const text = markdownOf(`intro\n\`\`\`ts\n${'x'.repeat(100)}`, 50)

    expect(text.length).toBeLessThan(150)
    expect(text).toContain('\n```\n\n*… cut here')
    expect(markdownOf('a'.repeat(10), 10)).toBe('a'.repeat(10))
  })
})
