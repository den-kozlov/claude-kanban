// The detail popup (spec section 5): the tree the `issue` pane draws for one
// issue. Plain elements, so the engine scrolls it and a Button's hotkey works
// while the pane holds the keys; Esc closes the pane.

import type { ElementTable, RenderChildren } from 'claude-code'

import type { Detail, IssueDetail, IssueLink } from '../types'
import { oneLine, truncate } from './lib/text'

type Elements = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Markdown'>

export type PopupActions = {
  /** Shows that issue in the popup and selects it on the board. */
  select: (number: number) => void
  open: (number: number) => void
}

const LABEL_WIDTH = 11

/** The pane's tab: `#N title`, cut to 40 cells. */
export function popupTitle(number: number, title: string | null): string {
  return truncate(title === null ? `#${number}` : `#${number} ${oneLine(title)}`, 40)
}

export function drawPopup(
  elements: Elements,
  detail: Detail,
  where: { columns: number; column: string | null },
  actions: PopupActions,
) {
  const { Box, Text, Button, Markdown } = elements
  const rule = <Text dimColor>{'─'.repeat(Math.max(1, Math.min(where.columns, 80)))}</Text>
  const openButton = (
    <Button key="open" plain hotkey="o" onPress={() => actions.open(detail.number)}>
      Open in browser
    </Button>
  )

  const field = (name: string, value: RenderChildren) => (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{name}</Text>
      </Box>
      {value}
    </Box>
  )

  const link = (one: IssueLink) => (
    <Box flexDirection="row">
      <Button key={`link:${one.number}`} plain onPress={() => actions.select(one.number)}>
        {`#${one.number} ${one.title}`}
      </Button>
      <Text dimColor>{one.isOpen ? '  open' : '  closed'}</Text>
    </Box>
  )

  const issueView = (issue: IssueDetail) => {
    const facts = [issue.isOpen ? 'open' : 'closed', where.column, `Priority ${issue.priority ?? 'none'}`]
    return (
      <Box flexDirection="column">
        <Text bold>{`#${issue.number} ${issue.title}`}</Text>
        <Text dimColor>{facts.filter(fact => fact !== null).join(' · ')}</Text>
        <Text> </Text>
        {field('Labels', <Text>{issue.labels.length === 0 ? '—' : issue.labels.join(', ')}</Text>)}
        {field('Assignees', <Text>{issue.assignees.length === 0 ? '—' : issue.assignees.join(', ')}</Text>)}
        {field('Parent', issue.parent === null ? <Text>—</Text> : link(issue.parent))}
        {field(
          'Blockers',
          issue.blockers.length === 0 ? (
            <Text>—</Text>
          ) : (
            <Box flexDirection="column">{issue.blockers.map(link)}</Box>
          ),
        )}
        <Text> </Text>
        {rule}
        {issue.body === '' ? <Text dimColor>No description.</Text> : <Markdown text={issue.body} />}
        {rule}
        <Text bold>
          {issue.commentCount === 0
            ? 'No comments'
            : issue.commentCount <= issue.comments.length
              ? `Comments ${issue.commentCount}`
              : `Comments ${issue.commentCount}, the last ${issue.comments.length}`}
        </Text>
        {issue.comments.map(comment => (
          <Box flexDirection="column" marginTop={1}>
            <Text color="claude">{`${comment.author} · ${comment.createdAt.slice(0, 10)}`}</Text>
            <Markdown text={comment.body === '' ? '*(empty)*' : comment.body} />
          </Box>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={where.columns}>
      {detail.issue !== null && detail.issue.number === detail.number ? (
        issueView(detail.issue)
      ) : detail.error !== null ? (
        <Text color="error">{`Could not load #${detail.number}: ${detail.error}`}</Text>
      ) : (
        <Text dimColor>{`Loading #${detail.number}…`}</Text>
      )}
      <Text> </Text>
      <Box flexDirection="row" columnGap={3}>
        {openButton}
        <Text dimColor>Esc closes</Text>
      </Box>
    </Box>
  )
}
