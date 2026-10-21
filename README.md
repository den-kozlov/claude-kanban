# claude-kanban

A Claude Code mod: a kanban board of the current repository's GitHub issues in a pane beside the
transcript. Cards are ordered by the GitHub `Priority` issue field and collapse to one line when a
column does not fit. `s` starts a card with the prompt its labels call for (`/triage`,
`/wayfinder` or `/implement`) in the current session; `S` starts it in a parallel
interactive Claude session (a new Orca or iTerm tab).

Design: [docs/spec.md](docs/spec.md).

## Install

From GitHub, in the user scope (every session, every repository):

```sh
claude plugin install kanban-board --marketplace den-kozlov/claude-kanban
```

The board needs `gh` signed in to GitHub. `S` starts sessions in Orca or iTerm, so it needs macOS
with one of them.

To work on the mod, install it from a clone instead:

```sh
claude plugin install kanban-board --marketplace ~/projects/claude-kanban
```

Claude Code then reads the mod from that folder: after an edit, run `/reload-plugins` in an open
session.

## Use

`/board` opens the board beside the transcript, and closes it. Click the board to give it the keys:

| Key | Action |
|---|---|
| arrows / click | select a card |
| `Enter` | show the card's details in the board (`Backspace` goes back to the columns) |
| `s` | start the card in the current session: its prompt runs as if you typed it |
| `S` | start the card in a new Claude session (a new Orca tab inside Orca, else an iTerm tab) |
| `s` / `S` | on a card whose session runs, bring its tab forward; on In progress or Review, resume its last session in a new tab |
| `o` | open the issue in the browser |
| `p` / `P` | next Priority (none → Urgent → High → Medium → Low → none) / clear it |
| `r` | refresh now |
| `d` | show / hide Done |
| `f` | filter by a container (`prd`, `ideas`, `wayfinder:map`) |

The detail view shows the labels, Priority, assignees, parent and blockers, the description and
the last three comments. `↑`/`↓` go from link to link (the parent, then the blockers) and
scroll the text past them; `Enter` (or a click on the link) shows that issue; back on the columns, it is the card
selected. `s`/`S`, `o` and `p`/`P` act on the issue shown. `Esc` gives the keys back to the prompt,
as everywhere in Claude Code: a click on the board takes them again.

A session the board started reports its state to the board: the card shows `starting`,
`working`, `waiting for input` or `ended`, and stands in In progress while the session runs.
That is the current session for `s` and the new one for `S`. The new session reports through
this mod, so the mod must load there too (the user-scope install does that). The current session
reports the same state for every card `s` started in it: it is one session.

Priority is the organization's `Priority` issue field. The card moves with each press; the board
writes the value 2 seconds after the last press. Where the repository's owner has no such
field (a user account, or an organization without it), `p` and `P` are off.

The board shares its place with Claude Code's diff panel: when you do not see the board, hide
the diff panel with `/diff`.

## The terminal board

The same board runs in a terminal of its own, with no Claude Code session: the same columns,
keys, detail view, Priority writes and starting cards. It needs [Bun](https://bun.sh) and `gh`.
From a clone, or from the installed plugin's folder:

```sh
bin/kanban-board                 # the repository of the current folder
bin/kanban-board ~/projects/app  # another one
```

The keys are the pane's, and the board takes them without a click. The terminal board has no
session of its own, so `s` starts a card in a new session, as `S` does. `Esc` goes back from the
detail view and closes the filter; `q` or `Ctrl-C` quits (a Priority not yet written is
written first). A click selects a card, the wheel
moves the selection. Toasts show in the bottom line.

The terminal board reads and writes the mod's store (`~/.claude/plugins/store/kanban-board_*.json`,
under `CLAUDE_CONFIG_DIR` when it is set), so it shows the sessions the pane started, and the
pane shows the ones it starts. The sessions it starts report their state through the mod, so the
mod must be installed in the user scope. When the mod is installed from two marketplaces, the
board takes the newest store file; `KANBAN_BOARD_STORE=<path>` names another one.

## Configure

The defaults follow the mattpocock triage labels. `.claude/kanban.json` in the repository changes
any part of them: the labels of each column, the container labels, the prompts `s` starts with,
the branch patterns, how many days Done shows and how often the board refreshes.
[`docs/kanban.example.json`](docs/kanban.example.json) gives every option with its default: copy
it to `.claude/kanban.json` and change what you need, or keep only the parts you change.

| Option | Default | What it is |
|---|---|---|
| `columns.triage`, `.needsInfo`, `.readyForAgent`, `.readyForHuman` | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` | The labels that put an open issue in the column |
| `containers` | `prd`, `ideas`, `wayfinder:map` | The labels of issues that hold others: the board shows them as a filter, not as cards |
| `launch` | `/triage`, `/wayfinder`, `/implement` rules | The prompt `s`/`S` starts a card with (below) |
| `branchPatterns.issue`, `.fallback`, `.sandcastle` | `issue-(\d+)`, `-(\d+)$`, `^sandcastle/issue-(\d+)$` | Regular expressions that find the issue number in a branch name; each needs a group around the number |
| `doneDays` | `7` | How far back the Done column reaches, in days (1–365) |
| `refreshSeconds` | `60` | How often the board reads GitHub, in seconds (15–3600) |

The full rules are in [section 10 of the spec](docs/spec.md#10-configuration). For example:

```json
{
  "columns": { "readyForHuman": ["ready-for-human", "human"] },
  "refreshSeconds": 120
}
```

Each `launch` rule gives the prompt for the issues with its label (`label`), a label that starts
with `labelPrefix`, or a parent with `parentLabel`; the first that matches wins. In the prompt,
`{n}` is the issue's number and `{title}` its title:

```json
{
  "launch": [
    { "label": "needs-triage", "prompt": "/triage #{n}" },
    { "label": "ready-for-human", "prompt": "/implement #{n} ({title})" }
  ]
}
```

`launch` replaces the default list whole, so give every rule you want.

`doneDays` is how far back the Done column reaches (the issues closed in the last N days);
`d` only shows or hides that column.

The board reads the file at each refresh, so an edit shows after `r`. A session in a linked
worktree with no file of its own reads the main worktree's. A part that is wrong keeps its
default, and the status bar says what is wrong (`⚠ kanban.json: …`).

## Develop

```sh
claude --plugin-dir . --debug   # a session with the mod loaded; edits hot-reload
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p tui    # type-check the terminal board
```
