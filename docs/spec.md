# claude-kanban: design spec

Status: agreed with the owner on 2026-10-20 (grilling session, questions Q1–Q31).

A Claude Code mod that shows the GitHub issues of the current repository as a kanban board in a
pane beside the transcript, and starts an issue in a parallel interactive Claude session. It is
built to work with the mattpocock skills (`/triage`, `/wayfinder`, the triage label vocabulary)
and with Sandcastle, which takes `ready-for-agent` issues on its own.

## 1. Scope

- One generic plugin, installed in the user scope. It works with the repository of the session it
  runs in (`gh repo view --json nameWithOwner`). No project-specific code.
- The board opens and closes with `/board`. It never opens on its own, neither at session start
  nor in the parallel sessions it starts (the plugin loads there too, to report session state).
- UI text (column names, buttons, hints) is English. Issue titles are shown as they are.

## 2. Columns

Left to right. An issue lands in the first column whose rule matches, in this order of precedence:
Done, Review, In progress, Blocked, then the label columns.

| Column | Rule |
|---|---|
| Blocked | At least one blocker (GitHub issue dependencies) is open. Overrides any label. |
| Triage | label `needs-triage` |
| Needs info | label `needs-info` |
| Ready for agent | label `ready-for-agent` (Sandcastle takes these) |
| Ready for human | label `ready-for-human` |
| In progress | a live or recorded board session for the issue, a worktree or branch matching `issue-<N>`, or a Sandcastle branch `sandcastle/issue-<N>` (badge `sandcastle`) |
| Review | an open PR for the issue (section 6) |
| Done | closed in the last 7 days; hidden by default, `d` toggles it |

Open issues that match no rule go to Triage.

**Containers.** Issues labelled `prd`, `ideas` or `wayfinder:map` are not tasks and never stand in
a column. They feed a filter (`f`): choosing one shows only its sub-issues (GitHub `parent`).
No filter shows every task.

**Layout.** Columns stand side by side. An empty column shrinks to its header. When the pane is
narrower than the minimum for the visible columns, the board stacks the columns as sections, one
under another. The board sizes its tree to `e.props.bodyColumns`.

## 3. Cards

A full card shows:
- `#N` and the title (up to two lines);
- up to three labels (container and column labels excluded);
- the comment count;
- a session badge: working / waiting for input / ended (section 8);
- a PR badge with its CI state, when a PR exists.

**Order.** Within a column, by Priority (Urgent → High → Medium → Low → none), then by number
ascending (oldest first).

**Collapse.** Every card is full while the column fits on the screen. When it does not, the board
collapses cards into one-line rows (`#N title`), starting from the end of the order (the lowest
priority), until the column fits. When even the rows do not fit, the column scrolls.

**Selection.** A selected collapsed row expands to a full card for as long as it is selected; the
next card below collapses to make room.

## 4. Priority

Priority is the organization-level GitHub **issue field** named `Priority` (single select: Urgent,
High, Medium, Low), not a label and not a Projects v2 field.

- Read: `issueFieldValues` on each issue (query in section 9).
- Find the field and option ids by name at start: `organization(login).issueFields`. Never
  hardcode ids: each organization has its own.
- Set: `setIssueFieldValue(input:{issueId, issueFields:[{fieldId, singleSelectOptionId}]})`.
- Clear: `deleteIssueFieldValue(input:{issueId, fieldId})`.
- REST alternative: `POST repos/{o}/{r}/issues/{n}/issue-field-values` with
  `{"issue_field_values":[{"field_id":<int>,"value":"High"}]}`; never `PUT` (it replaces every
  field value of the issue).
- `p` cycles the value of the selected card (none → Urgent → High → Medium → Low → none), `P`
  clears it. The card moves at once (optimistic update); a failed write
  reverts it and shows a toast.
- A repository whose owner has no `Priority` issue field (a user account, or an org without it):
  every issue has one level and `p`/`P` are disabled. No label fallback.

## 5. Keys and the detail popup

| Key | Action |
|---|---|
| arrows / mouse click | select a card |
| `Enter` | open the detail popup |
| `s` | start the card (section 7) |
| `o` | open the issue in the browser |
| `p` / `P` | cycle / clear Priority |
| `f` | choose a container filter |
| `d` | show / hide Done |
| `r` | refresh now |

**Detail popup** (a second pane over the board, `Esc` closes it): title, labels, Priority,
assignees, blockers and parent (each a link that selects that issue), the body as Markdown, the
last three comments, and buttons Start (`s`), Open in browser (`o`), Priority (`p`).

## 6. Data and refresh

- GitHub: every 60 seconds and on `r`. Local session state: every 2–3 seconds.
- `gh` runs through `$.process.run` (no shell; 30 s default timeout). `gh api graphql` fails now and
  then with `Post https://api.github.com/graphql: EOF`: retry with backoff, keep the last good data
  on screen.
- **Review detection.** GitHub links a PR to an issue only through closing keywords
  (`closedByPullRequestsReferences`), and repositories that write `Refs #N` get nothing there. So
  the board also lists open PRs (`headRefName`, body, `isDraft`, `statusCheckRollup`) and matches an
  issue by `issue-(\d+)` in the head branch, or `-(\d+)$` as a fallback, or by `#N` in the body.
- **In progress detection.** `git worktree list --porcelain` and `git branch -a` matched with the
  branch patterns of the config; the board's session records (section 8).
- **Done.** A second query: issues closed in the last N days (search
  `repo:<o>/<r> is:issue is:closed closed:>=<date>`).

## 7. Starting a card

`s` (or Start in the popup) opens a new interactive Claude session for the issue, visible at once.
The board never writes to GitHub when it starts a card; the skills do what they need (assignees,
comments, labels).

**Where.** Always the repository root. The session creates a worktree itself when it needs one
(for example `/wayfinder` makes `wayfinder/…` or `research/…` branches). The board makes no
worktree and no branch.

**How.**
1. Generate a session UUID and record `{issue, sessionId, startedAt}` (section 8).
2. Inside Orca (`TERM_PROGRAM=Orca`): `orca terminal create --worktree path:<repo root> --command
   "claude --session-id <uuid> --name '#N <title>' '<prompt>'" --json`; keep the terminal handle
   to focus that tab later.
3. Outside Orca: a new iTerm tab through `osascript`, running the same command in the repo root.

**Prompt.** The first rule that matches:
1. label `needs-triage` → `/triage #N`;
2. a `wayfinder:*` label, or a parent labelled `wayfinder:map` → `/wayfinder #N`;
3. label `ready-for-human` → `Start implementing issue #N`.

**Other columns.**
- In progress, Review: a live session → focus its tab; otherwise a new tab with
  `claude --resume <uuid>` in the repo root (the last recorded session of the issue).
- Blocked, Needs info, Ready for agent, Done: no start (the key does nothing; the popup shows the
  button disabled with the reason).

## 8. Session tracking

- The board records `{issue → [sessionId, terminal handle, startedAt]}` per repository.
- The plugin, loaded in every session, checks at `session.start` whether its own session id is in
  those records. If it is, its hooks report the state: `turn.start` → working; `turn.end` and
  permission prompts → waiting for input; `session.end` → ended. A heartbeat every 10 s; a state
  older than 30 s reads as ended.
- Storage: `$.store` if it is shared between concurrent sessions of the plugin (verify first);
  otherwise a JSON file per session under the plugin's data directory, written atomically.
- No notifications in the first version (Orca shows waiting agents itself).

## 9. Issue query

`gh api graphql --paginate -F owner=<o> -F name=<r> -F query=@issues.graphql` (the variable must
be named `$endCursor` for `--paginate`):

```graphql
query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){
    issues(first:50, after:$endCursor, states:OPEN, orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        id number title
        labels(first:20){nodes{name}}
        assignees(first:10){nodes{login}}
        comments{totalCount}
        blockedBy(first:20){nodes{number state}}
        parent{number title state}
        subIssuesSummary{total completed}
        issueFieldValues(first:10){nodes{
          __typename
          ... on IssueFieldSingleSelectValue{ name optionId field{ ... on IssueFieldSingleSelect{ id name } } }
        }}
        closedByPullRequestsReferences(first:10, includeClosedPrs:false){nodes{number state isDraft}}
      }
    }
  }
}
```

Count open blockers from `blockedBy.nodes` where `state == OPEN` (the meaning of
`issueDependenciesSummary.blockedBy` is unconfirmed). The body and comments of the popup come from
a separate query when the popup opens.

## 10. Configuration

Defaults follow the mattpocock vocabulary. `.claude/kanban.json` in the repository overrides any
part of it:

```json
{
  "columns": {
    "triage": ["needs-triage"],
    "needsInfo": ["needs-info"],
    "readyForAgent": ["ready-for-agent"],
    "readyForHuman": ["ready-for-human"]
  },
  "containers": ["prd", "ideas", "wayfinder:map"],
  "launch": [
    { "label": "needs-triage", "prompt": "/triage #{n}" },
    { "labelPrefix": "wayfinder:", "parentLabel": "wayfinder:map", "prompt": "/wayfinder #{n}" },
    { "label": "ready-for-human", "prompt": "Start implementing issue #{n}" }
  ],
  "branchPatterns": { "issue": "issue-(\\d+)", "fallback": "-(\\d+)$", "sandcastle": "^sandcastle/issue-(\\d+)$" },
  "doneDays": 7,
  "refreshSeconds": 60
}
```

## 11. Platform facts (Claude Code mod API)

From the bundled `plugin-authoring` skill and its `types/claude-code.d.ts`, which is the authority:
- Layout: `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{"modules":["./register.tsx"]}`),
  `hooks/register.tsx` exporting `register(on, options)`. No DOM, no Node; everything goes through `$`.
- Pane: `$.ui.open({ id, title, focus, … })`, drawn by `on('ui.render', { component: 'Pane', requestId })`.
  Placed beside the transcript in fullscreen, inline above the prompt otherwise.
- Input: `Button` (`onPress`, `hotkey`), `Input`, `Select`; a `Client` surface gets raw
  `onKey`/`onPointer`. Keys reach the pane only while it holds focus.
- State: `$.state` atoms redraw their readers; render hooks never write. `$.store` persists across
  sessions. Background work: `$.clock.every` from `session.start`.
- Processes: `$.process.run(argv, { cwd, timeoutMs })`, output capped at 4 MiB.
- Limits: a tree draws its first 100,000 characters; a Client tree 20,000 nodes, 32 deep.
- Checks: `claude plugin validate`, `claude plugin test` (`*.test.ts`), `tsc`; develop with
  `claude --plugin-dir <dir>`.

## 12. Delivery plan

1. Read-only board: query, column rules, cards, order, collapse, scroll, layout, `/board`, `r`, `o`, `d`, `f`.
2. Detail popup.
3. Priority: read, `p`/`P` writes.
4. Starting cards: prompts, Orca tab, iTerm fallback, session records.
5. Session tracking: the reporter in parallel sessions, badges, focus/resume.
6. Configuration file.

## 13. Open checks for implementation

- Is `$.store` shared between concurrent sessions of one plugin?
- Does a mod see its own session id at `session.start`, and is there a hook for permission prompts?
- The Orca command that focuses an existing terminal tab by handle.
- `claude --session-id` together with an initial prompt and `--name` in one command.
