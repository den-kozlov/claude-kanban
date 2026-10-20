// What the board reads from GitHub (through `gh`) and from git. Every
// command runs through `$.process.run`: no shell.

import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { RawIssue, RawPr, Snapshot } from './model'

const ISSUE_FIELDS = `
  number title
  labels(first:20){nodes{name}}
  comments{totalCount}
  parent{number}`

// Section 9 of the spec; the body and the comments wait for the popup.
const OPEN_ISSUES = `query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){
    issues(first:50, after:$endCursor, states:OPEN, orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        ${ISSUE_FIELDS}
        blockedBy(first:20){nodes{number state}}
        issueFieldValues(first:10){nodes{
          __typename
          ... on IssueFieldSingleSelectValue{ name field{ ... on IssueFieldSingleSelect{ name } } }
        }}
        closedByPullRequestsReferences(first:10, includeClosedPrs:false){nodes{number state isDraft}}
      }
    }
  }
}`

const OPEN_PRS = `query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:50, after:$endCursor, states:OPEN, orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number headRefName body isDraft statusCheckRollup{state} }
    }
  }
}`

const DONE_ISSUES = `query($q:String!,$endCursor:String){
  search(type:ISSUE, query:$q, first:50, after:$endCursor){
    pageInfo{hasNextPage endCursor}
    nodes{ ... on Issue { ${ISSUE_FIELDS} } }
  }
}`

/** What the reads need of the host: `$.process.run` and `$.clock.sleep`, wrapped by the hooks module. */
export type Shell = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  sleep: (ms: number) => Promise<void>
}

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }

const RETRIES = [1000, 2000, 4000]
const MAX_PAGES = 20

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** `gh api graphql`, again with backoff when it fails (it answers `EOF` now and then). */
async function graphql(
  shell: Shell,
  cwd: string,
  query: string,
  variables: Record<string, string>,
): Promise<unknown> {
  const argv = ['gh', 'api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) argv.push('-f', `${name}=${value}`)

  let failure = ''
  for (let attempt = 0; attempt <= RETRIES.length; attempt += 1) {
    if (attempt > 0) await shell.sleep(RETRIES[attempt - 1] as number)
    const run = await shell.run(argv, { cwd, timeoutMs: 30_000 }).catch((error: unknown) => ({
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }))
    if (run.exitCode === 0) {
      let parsed: { data?: unknown; errors?: { message: string }[] } = {}
      try {
        parsed = JSON.parse(run.stdout) as typeof parsed
      } catch {
        failure = 'gh answered no JSON'
        continue
      }
      if (parsed.data !== undefined && parsed.data !== null) return parsed.data
      failure = parsed.errors?.[0]?.message ?? 'no data'
    } else {
      failure = firstLine(run.stderr) || `gh exited with ${run.exitCode}`
    }
  }
  throw new Error(failure)
}

async function paginate<T>(
  shell: Shell,
  cwd: string,
  query: string,
  variables: Record<string, string>,
  pageOf: (data: unknown) => Page<T>,
): Promise<T[]> {
  const nodes: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await graphql(shell, cwd, query, cursor === null ? variables : { ...variables, endCursor: cursor })
    const { pageInfo, nodes: pageNodes } = pageOf(data)
    nodes.push(...pageNodes)
    if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break
    cursor = pageInfo.endCursor
  }
  return nodes
}

/** `owner/name` of the session's repository. */
export async function resolveRepo(shell: Shell, cwd: string): Promise<string> {
  const run = await shell.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd,
  })
  if (run.exitCode !== 0) throw new Error(firstLine(run.stderr) || 'not a GitHub repository')
  return run.stdout.trim()
}

/** The `YYYY-MM-DD` date `days` days before `now`. */
export function daysAgo(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10)
}

export async function fetchSnapshot(
  shell: Shell,
  cwd: string,
  repo: string,
  doneDays: number,
  now: number,
): Promise<Snapshot> {
  const [owner = '', name = ''] = repo.split('/')
  const [open, prs, done] = await Promise.all([
    paginate<RawIssue>(shell, cwd, OPEN_ISSUES, { owner, name }, data =>
      (data as { repository: { issues: Page<RawIssue> } }).repository.issues,
    ),
    paginate<RawPr>(shell, cwd, OPEN_PRS, { owner, name }, data =>
      (data as { repository: { pullRequests: Page<RawPr> } }).repository.pullRequests,
    ),
    paginate<RawIssue>(
      shell,
      cwd,
      DONE_ISSUES,
      { q: `repo:${repo} is:issue is:closed closed:>=${daysAgo(now, doneDays)}` },
      data => (data as { search: Page<RawIssue> }).search,
    ),
  ])
  // The search answers `{}` for a node that is not an issue.
  return { repo, open, prs, done: done.filter(issue => typeof issue.number === 'number') }
}

/**
 * The branch names of the repository's worktrees and its local and remote
 * branches, remote ones without the `<remote>/` prefix.
 */
export async function readBranches(shell: Shell, cwd: string): Promise<string[]> {
  const [worktrees, refs] = await Promise.all([
    shell.run(['git', 'worktree', 'list', '--porcelain'], { cwd, timeoutMs: 10_000 }),
    shell.run(['git', 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], {
      cwd,
      timeoutMs: 10_000,
    }),
  ])
  const names = new Set<string>()
  for (const line of worktrees.stdout.split('\n')) {
    if (line.startsWith('branch refs/heads/')) names.add(line.slice('branch refs/heads/'.length))
  }
  for (const ref of refs.stdout.split('\n')) {
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length))
    const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1]
    if (remote !== undefined && remote !== 'HEAD') names.add(remote)
  }
  return [...names].sort()
}

/** Opens the issue in the browser. */
export async function openIssue(shell: Shell, cwd: string, repo: string, number: number): Promise<void> {
  const run = await shell.run(['gh', 'issue', 'view', String(number), '--web', '-R', repo], { cwd })
  if (run.exitCode !== 0) throw new Error(firstLine(run.stderr) || `could not open #${number}`)
}
