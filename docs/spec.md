# claude-kanban: design spec

Status: agreed with the owner on 2026-10-20 (grilling session, questions Q1–Q31). Stages 1–5
of the delivery plan are built (section 12 says what each stage left for later).

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
| In progress | a running board session for the issue (starting, working or waiting), a worktree or branch matching `issue-<N>`, or a Sandcastle branch `sandcastle/issue-<N>` (badge `sandcastle`). An ended session moves no card: after `/triage` the card stands in the column its new labels give (the owner's reason, 2026-10-20, for keeping recorded sessions out until stage 5 could tell a running session from an ended one) |
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
- its Priority, when it has one (added in stage 3, so `p` shows what it set);
- up to three labels (container and column labels excluded);
- the comment count;
- a session badge: starting / working / waiting for input / ended (section 8; built in stage 5);
- a PR badge with its CI state, when a PR exists;
- (stage 4 showed `started` for a recorded session; stage 5 replaced it with the session badge).

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

As built (stage 3):
- The board reads the field once per session, with the first refresh:
  `repositoryOwner(login){ ... on Organization { issueFields(first:50) } }`, the
  `IssueFieldSingleSelect` named `Priority`, and each option by its name. A user account answers
  no fields. A failed read is tried again at the next refresh; until then `p`/`P` are off.
- The issue queries now ask for the node `id` (the writes take it), and the Done query reads
  `issueFieldValues` too, so a Done card shows its Priority.
- `p` cycles through the options the field has, from the value the card shows. `P` on a card
  with no Priority does nothing.
- The presses are a roulette, so the board writes once, 2 seconds after the last press on that
  issue (each press starts the wait again). When the presses come back to the value they started
  from, nothing is written. The writes of one issue run one after another. Each write goes
  through the same retry as a query (setting or clearing a value twice does no harm). A hot
  reload of the mod inside those 2 seconds drops the write.
- The card shows the new value at once. The board keeps it over GitHub's answer until a refresh
  that started after the write ended. A failed write drops it, shows
  `Could not set the Priority of #N: <reason>` in a toast and refreshes the board.
- Where `p`/`P` are off, they show the reason in a toast (for example `<owner> has no Priority
  issue field`), and the hints leave them out.
- In the detail view `p` cycles and `P` clears the Priority of the issue it shows, and the hints
  name them only where Priority is on.

## 5. Keys and the detail view

| Key | Action |
|---|---|
| arrows / mouse click | select a card |
| `Enter` | open the detail view of the card |
| `s` | start the card (section 7) |
| `o` | open the issue in the browser |
| `p` / `P` | cycle / clear Priority |
| `f` | choose a container filter |
| `d` | show / hide Done |
| `r` | refresh now |

**Detail view** (drawn in the board's pane in place of the columns, `Backspace` goes back):
title, labels, Priority, assignees, parent and blockers (each a link that shows that issue), the
body, the last three comments; `s` starts, `o` opens in the browser, `p`/`P` set the Priority.

| Key in the detail view | Action |
|---|---|
| `Backspace` | back to the columns |
| `↑` / `↓` | the next link on screen (the parent, then the blockers), else scroll a line |
| `PgUp` / `PgDn` / `Space`, `Home` / `End` | scroll |
| `←` / `→`, `Tab` | the next link, wherever it is |
| `Enter`, mouse click on a link | show that issue |
| `s`, `o`, `p` / `P`, `r` | as on the board, for the issue shown |

As built (stage 2, reworked after stage 5): stage 2 drew the issue in a second pane (`issue`,
opened with `focus` and `closeOnEscape`). The owner found that after `Esc` the board took no keys
until a click. The engine gives a `Client` the keys only on a click and takes them away when a
pane takes the focus, and no call gives them back (`$.ui.open` with `focus` gives the pane the
focus, not its `Client` the keys). `Escape` never reaches a `Client`: it gives the keys to the
prompt. So the board's `Client` draws the view itself, and `Backspace` closes it.
- The hooks module loads the issue into the `detail` state, and the board's props carry it;
  `detail` null means the columns. A link loads that issue and asks the board to select its
  card (the `pick` state; the board takes it when the card is in view, back on the columns).
- `hooks/lib/detail-view.ts` makes the lines, cut to the cell. The Markdown shows as plain
  text: each source line wrapped at words, its indent kept, tabs as four spaces.
- The body is cut at 10,000 characters and each comment at 2,000 (a code fence the cut leaves
  open is closed), so the props stay under 100,000 characters with the board beside them.
- The status bar names the issue and the lines in view, and the view's keys. The hints show
  always: the board cannot tell whether a click gave its `Client` the keys (the pane's
  `isFocused` is the pane's focus, which a click on the `Client` takes away).
- `/board` closing the board closes the view: the board opens again on its columns.

## 6. Data and refresh

- GitHub: every 60 seconds and on `r`. Local state: every 2–3 seconds (built: branches and
  worktrees every 3 s, with the session reports since stage 5).
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

`s` (on the board or in the detail view) opens a new interactive Claude session for the issue, visible at once.
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
- Blocked, Needs info, Ready for agent, Done: no start (the key does nothing; the detail view shows
  the reason).

As built (stage 4):
- `s` on the board and in the detail view. A card that does not start says why in a toast; the
  detail view draws `Start: <reason>` under its header line. Until stage 5, `s` on an In
  progress or Review card does nothing but say so (the owner's choice, 2026-10-20): focusing a
  live session and resuming the last one need session tracking.
- The prompt comes from the `launch` rules of the config (section 10), the first that matches.
  A Triage card no rule matches (an issue with no label) gets the rule of the triage label.
  A parent counts while it is open (the board holds only open issues and those closed lately).
- The repository root is the main worktree's folder (`git rev-parse --path-format=absolute
  --git-common-dir` less `/.git`), so a board in a linked worktree starts cards in the root too.
- The command: `claude --session-id <uuid> --name '#N <title>' '<prompt>'`, the name cut to 60
  cells, both quoted for the shell. The UUID is `crypto.randomUUID()`.
- Orca: `TERM_PROGRAM` read with `$.env.get` at `session.start`; `orca terminal create
  --worktree path:<root> --title '#N <title>' --command <command> --focus --json`. The handle is
  read from the JSON answer. A root Orca does not know as a worktree fails with Orca's reason.
- iTerm: `osascript` with a script that opens a tab in the current window (a window when none
  is open) and writes `cd <root> && <command>` into it; the command goes as an argument, never
  inside the script's text.
- The record `{sessionId, terminal, startedAt}` goes to `$.store` under `sessions:<owner/repo>`,
  by issue number, the last five per issue. The board reads the store again before it writes, so
  another board's records stay.
- A toast says where the session started and with which prompt; a failure says why. A second `s`
  while the tab opens does nothing.

As built (stage 5):
- `s` on a card whose session runs (starting, working, waiting) brings its tab forward, in any
  column: `orca terminal switch --terminal <handle>`, or in iTerm a script that selects the
  session with the id the new-tab script answered (`id of current session`). A closed iTerm tab
  says so in a toast.
- `s` on an In progress or Review card whose sessions ended resumes the last one: a new tab with
  `KANBAN_BOARD_SESSION=<record id> claude --resume <id>` in the repository root, the id being the
  one the session last reported (a `/clear` changes it). The record gets the new tab and time.
- In progress or Review with no board session (a branch, a PR): `s` says so and does nothing.
- A card in a label column whose session ended starts a new one with its prompt, as in stage 4.
- The detail view's hints say what `s` does: start, focus session or resume session; its
  header line names the session's state.

## 8. Session tracking

- The board records `{issue → [sessionId, terminal handle, startedAt]}` per repository.
- The plugin, loaded in every session, checks at `session.start` whether its own session id is in
  those records. If it is, its hooks report the state: `turn.start` → working; `turn.end` and
  permission prompts → waiting for input; `session.end` → ended. A heartbeat every 10 s; a state
  older than 30 s reads as ended.
- Storage: `$.store` if it is shared between concurrent sessions of the plugin (verify first);
  otherwise a JSON file per session under the plugin's data directory, written atomically.
- No notifications in the first version (Orca shows waiting agents itself).

As built (stage 5):
- `$.store` is shared: it is one JSON file per plugin, which the engine reads again on each get
  and locks for each set (read in the engine's code, 2.1.304). A set replaces one key, so each key
  has one writer: the board writes `sessions:<owner/repo>`, each session its own `live:<id>`.
- The session learns it is tracked from its environment, not from its id: the board's command is
  `KANBAN_BOARD_SESSION=<record id> claude …`. The reporter reads it with `$.env.get` at
  `session.start`, in an interactive session only (a `claude -p` the session runs inherits the
  variable and stays silent). So a resumed or `/clear`ed session reports under the same record.
- The report: `live:<record id>` → `{state, at, sessionId}`, `state` one of `working`, `waiting`,
  `ended`. `turn.start` of the main loop → working; its `turn.complete` → waiting;
  `classic.PermissionRequest` (the permission prompt) → waiting; `classic.PostToolUse` during a
  turn → working (the person answered); `session.end` → ended, except after `/clear`. Subagents'
  turns do not count. A write goes only when the state changes, plus a heartbeat every 10 s.
- The board reads the reports with the branches (every 3 s) and the records at each refresh. A
  session with no report reads as `starting` for 60 s after the board opened its tab, then as
  ended; a report older than 30 s reads as ended; a report from before the tab opened (before a
  resume) counts as none.
- A card shows the state of the session that needs the person first: waiting, working,
  starting, ended. A running one puts the card in In progress (section 2).
- A record that falls off the last five of its issue takes its report along.

## 9. Issue query

`gh api graphql --paginate -F owner=<o> -F name=<r> -F query=@issues.graphql` (the variable must
be named `$endCursor` for `--paginate`). As built, the board passes the query inline
(`-f query=…`) and follows `pageInfo` itself, at most 20 pages, so each page gets the `EOF` retry:

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
`issueDependenciesSummary.blockedBy` is unconfirmed). The body and comments of the detail view come
from a separate query when the view opens (built: `repository.issue(number:)` with `body`, `url`,
`state`, `assignees`, `blockedBy{number title state}`, `parent{number title state}`,
`issueFieldValues` and `comments(last:3)`; `number` goes as `-F` so it is an `Int!`).

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
2. Detail view.
3. Priority: read, `p`/`P` writes.
4. Starting cards: prompts, Orca tab, iTerm fallback, session records.
5. Session tracking: the reporter in parallel sessions, badges, focus/resume.
6. Configuration file.

| Stage | State | Built | Left for later |
|---|---|---|---|
| 1. Read-only board | done | Sections 2, 3 (without the session badge), 6 and 9; keys arrows/click, `o`, `r`, `d`, `f`; Priority read and card order | — (the session badge and sessions in In progress came with stage 5) |
| 2. Detail view | done | Section 5's view: `Enter`, the fields, links that select, the body, the last three comments, Open in browser (`o`), `Backspace`; Start (stage 4). First a pane of its own, drawn in the board after stage 5 | — |
| 3. Priority | done | Section 4: read (stage 1), field and option ids by name, `p`/`P` on the board and in the detail view, the move at once, revert with a toast, off without the field; the Priority on full cards | — |
| 4. Starting cards | done | Section 7: `s` on the board and in the detail view, the prompts from `launch` rules, the repository root, the Orca tab, the iTerm tab, session records in `$.store`, the `started` badge | — (focus, resume and In progress came with stage 5) |
| 5. Session tracking | done | Section 8: the reporter in the started sessions, the session badge on cards and in the detail view, a running session in In progress, `s` focusing its tab or resuming the last session | Notifications (not planned) |
| 6. Configuration file | not started | `Config` and `DEFAULT_CONFIG` in `hooks/lib/model.ts` hold section 10's shape, `launch` included | Reading `.claude/kanban.json` and merging it over the defaults |

## 13. Open checks for implementation

Learned while building stages 1–4:
- A `Client` gets keys only after the person clicks it; `Escape` gives them back to the prompt
  and never reaches the `Client`. A pane that takes the focus takes the keys from the `Client`,
  and nothing but a click gives them back (section 5).
- The engine's diff panel (`/diff`) takes the dock: a mod pane stays open and placed but is not
  drawn while it shows.
- The owner checked the detail popup by hand in a live session on 2026-10-20: it worked, but
  after `Esc` the board needed a click for its keys. The detail view in the board replaced it.
- The Priority writes: the tests cover them with a fake `gh`; the field read was checked live
  against an organization with the field. The owner checked the writes and the 2 s wait
  in a live session on 2026-10-20: they work.
- A mod reads `TERM_PROGRAM` through `$.env.get` (a string literal the validator lists) and its
  own session id through `$.session.id()`.
- `orca terminal switch --terminal <handle>` focuses an existing Orca tab by its handle.
- `claude --help` lists `--session-id <uuid>`, `-n, --name <name>` and the positional prompt
  together; `--resume <id>` takes a session id.
- The owner checked `s` in Orca and in iTerm in a live session on 2026-10-20: the new session
  starts with its name and prompt.
- `$.store` is shared between concurrent sessions (section 8, as built).
- The permission prompt is `classic.PermissionRequest`; a function hook hears it with no settings
  hook configured.
- The iTerm scripts compile (`osacompile`); running them from the sandboxed shell timed out on
  the Apple Events permission, so the focus by session id waits for a hand check.

To check by hand (stage 5):

- In Orca: `s` on a Triage card. The card goes to In progress with `starting`, then `working`,
  then `waiting for input` when the turn ends; a permission prompt in that session shows
  `waiting for input` too. `s` on it again brings its tab forward.
- Exit the session (`/exit`): the card shows `ended` and goes back to its label column.
- On an In progress or Review card with an ended session: `s` resumes it in a new tab.
- The same in iTerm, focus included.
