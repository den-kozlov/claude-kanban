# claude-kanban

A Claude Code mod: a kanban board of the current repository's GitHub issues in a pane beside the
transcript. Cards are ordered by the GitHub `Priority` issue field and collapse to one line when a
column does not fit. `s` starts a card in a parallel interactive Claude session (a new Orca or
iTerm tab) with the prompt its labels call for: `/triage`, `/wayfinder` or an implementation brief.

Design: [docs/spec.md](docs/spec.md).
