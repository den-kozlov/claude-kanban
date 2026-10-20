# claude-kanban

A Claude Code mod: a kanban board of the current repository's GitHub issues in a pane beside the
transcript. Cards are ordered by the GitHub `Priority` issue field and collapse to one line when a
column does not fit. `s` starts a card in a parallel interactive Claude session (a new Orca or
iTerm tab) with the prompt its labels call for: `/triage`, `/wayfinder` or an implementation brief.

Design: [docs/spec.md](docs/spec.md).

## Install

From a clone of this repository, in the user scope (every session, every repository):

```sh
claude plugin install kanban-board --marketplace ~/projects/claude-kanban
```

Claude Code reads the mod from that folder: after an edit, run `/reload-plugins` in an open session.

## Use

`/board` opens the board beside the transcript, and closes it. Click the board to give it the keys:

| Key | Action |
|---|---|
| arrows / click | select a card |
| `Enter` | show the card's details in the board (`Backspace` goes back to the columns) |
| `s` | start the card in a new Claude session (a new Orca tab inside Orca, else an iTerm tab); on a card whose session runs, bring its tab forward; on In progress or Review, resume its last session |
| `o` | open the issue in the browser |
| `p` / `P` | next Priority (none → Urgent → High → Medium → Low → none) / clear it |
| `r` | refresh now |
| `d` | show / hide Done |
| `f` | filter by a container (`prd`, `ideas`, `wayfinder:map`) |

The detail view shows the labels, Priority, assignees, parent and blockers, the description and
the last three comments. `↑`/`↓` go from link to link (the parent, then the blockers) and
scroll the text past them; `Enter` (or a click on the link) shows that issue; back on the columns, it is the card
selected. `s`, `o` and `p`/`P` act on the issue shown. `Esc` gives the keys back to the prompt,
as everywhere in Claude Code: a click on the board takes them again.

A session the board started reports its state to the board: the card shows `starting`,
`working`, `waiting for input` or `ended`, and stands in In progress while the session runs.
The new session reports through this mod, so the mod must load there too (the user-scope install
does that).

Priority is the organization's `Priority` issue field. The card moves with each press; the board
writes the value 2 seconds after the last press. Where the repository's owner has no such
field (a user account, or an organization without it), `p` and `P` are off.

Needs `gh` signed in to GitHub. The board shares its place with Claude Code's diff panel: when you
do not see the board, hide the diff panel with `/diff`.

## Configure

The defaults follow the mattpocock triage labels. `.claude/kanban.json` in the repository changes
any part of them: the labels of each column, the container labels, the prompts `s` starts with,
the branch patterns, how many days Done shows and how often the board refreshes. The full
shape is in [section 10 of the spec](docs/spec.md#10-configuration). For example:

```json
{
  "columns": { "readyForHuman": ["ready-for-human", "human"] },
  "refreshSeconds": 120
}
```

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
```
