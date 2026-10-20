import type { Card } from '../types'
import type { RawIssue, RawPr } from '../hooks/lib/model'

export function issue(number: number, extra: Partial<RawIssue> & { labelNames?: string[]; priority?: string } = {}): RawIssue {
  const { labelNames = [], priority, ...rest } = extra
  return {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    labels: { nodes: labelNames.map(name => ({ name })) },
    comments: { totalCount: 0 },
    parent: null,
    blockedBy: { nodes: [] },
    issueFieldValues: {
      nodes: priority === undefined ? [] : [{ __typename: 'IssueFieldSingleSelectValue', name: priority, field: { name: 'Priority' } }],
    },
    closedByPullRequestsReferences: { nodes: [] },
    ...rest,
  }
}

export function pr(number: number, headRefName: string, body = '', ci: string | null = null): RawPr {
  return { number, headRefName, body, isDraft: false, statusCheckRollup: ci === null ? null : { state: ci } }
}

export function card(number: number, extra: Partial<Card> = {}): Card {
  return {
    number,
    title: `Card ${number}`,
    column: 'triage',
    labels: [],
    comments: 0,
    priority: null,
    parent: null,
    pr: null,
    isSandcastle: false,
    isStarted: false,
    noStart: null,
    ...extra,
  }
}
