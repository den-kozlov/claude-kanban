# claude-kanban

A Claude Code mod: a kanban board of the current repository's GitHub issues in a pane beside the
transcript. Cards are ordered by the GitHub `Priority` issue field and collapse to one line when a
column does not fit. `s` starts a card in a parallel interactive Claude session (a new Orca or
iTerm tab) with the prompt its labels call for: `/triage`, `/wayfinder` or an implementation brief.

Design: [docs/spec.md](docs/spec.md).

## Use

`/board` opens the board beside the transcript, and closes it. Click the board to give it the keys:

| Key | Action |
|---|---|
| arrows / click | select a card |
| `o` | open the issue in the browser |
| `r` | refresh now |
| `d` | show / hide Done |
| `f` | filter by a container (`prd`, `ideas`, `wayfinder:map`) |

Needs `gh` signed in to GitHub. The board shares its place with Claude Code's diff panel: when you
do not see the board, hide the diff panel with `/diff`.

## Develop

```sh
claude --plugin-dir . --debug   # a session with the mod loaded; edits hot-reload
claude plugin validate .
claude plugin test .
```
