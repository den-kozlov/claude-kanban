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
| `Enter` | open the detail popup of the card (`Esc` closes it) |
| `o` | open the issue in the browser |
| `r` | refresh now |
| `d` | show / hide Done |
| `f` | filter by a container (`prd`, `ideas`, `wayfinder:map`) |

The detail popup shows the labels, Priority, assignees, parent and blockers (press one to show
that issue and select it on the board), the description and the last three comments; `o` there
opens the issue in the browser.

Needs `gh` signed in to GitHub. The board shares its place with Claude Code's diff panel: when you
do not see the board, hide the diff panel with `/diff`.

## Develop

```sh
claude --plugin-dir . --debug   # a session with the mod loaded; edits hot-reload
claude plugin validate .
claude plugin test .
```
