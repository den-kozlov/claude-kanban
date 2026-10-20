# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod (a plugin of function hooks) named `kanban-board`: a kanban board of the current
repository's GitHub issues in a pane beside the transcript, opened and closed with `/board`. The
design is `docs/spec.md`; its section 12 is the delivery plan. Stage 1 (read-only board) is built;
the detail popup, Priority writes, starting cards, session tracking and the config file are not.

The repository root is the plugin folder. The plugin name cannot start with `claude-` (the
validator reserves it), so the repo is `claude-kanban` and the plugin `kanban-board`; the
`$.state` keys and `types/index.d.ts` use the plugin name.

## Commands

- `claude plugin validate .` — checks the manifest and the hooks module the way the engine loads them.
  Run it after every change to `hooks/`: it catches API misuse that `tsc` does not.
- `claude plugin test .` — runs every `*.test.ts(x)`; there is no per-test filter.
- `npx -p typescript tsc -p .` — type-check. `tsconfig.json` includes `.claude-plugin/types`, which the
  engine writes (git-ignored) when it loads the mod from a watched folder; before that, point a
  scratch tsconfig at the `claude-code.d.ts` the `plugin-authoring` skill lays out.
- `claude --plugin-dir . --debug` — run a session with the mod loaded; edits hot-reload.

The API declarations (`.claude-plugin/types/claude-code/index.d.ts`) are the authority on every
event, `$` noun and element prop; grep them rather than guessing.

## Architecture

Two runtimes talk through messages:

- `hooks/register.tsx`, the hooks module. It registers `/board`, opens and closes the `board` pane,
  and keeps the data fresh while the pane is open: GitHub every 60 s, local branches every 3 s.
  It writes the built board and the refresh status to `$.state`. Its `ui.render` hook for the pane
  only hands that state as props to a `Client`.
- `hooks/board.tsx`, the `Client`'s surface module. It runs on the drawing thread with no `$`. It owns
  what belongs to the viewer: the selection, Done shown or hidden, the container filter and each
  column's scroll window. It handles raw keys and pointer events, and posts `refresh` / `open` to
  the hooks module (`ui.message`). Keys reach it only after the person clicks the board.

Pure logic, shared by both and covered by the tests:

- `hooks/lib/model.ts` — the column rules and their precedence, PR and branch matching, card order.
- `hooks/lib/layout.ts` — the cell-exact layout: side-by-side or stacked columns, collapse to
  one-line rows, scroll windows, arrow navigation, hit testing. The surface module draws exactly
  these rows, so every text is cut by `hooks/lib/text.ts`, never wrapped by the terminal.
- `hooks/lib/github.ts` — the `gh api graphql` queries (own pagination, retry with backoff for
  the `EOF` failures) and the git reads.

## Platform rules that bite

- `$` may appear only as `$.noun.method(...)` at a call site: never assign it, pass it to a function
  or return it (the validator refuses the module). Work outside a hook goes through closures bound in
  `session.start` (the `Host` object in `register.tsx`; `Shell` in `github.ts`). The state helpers
  `read($, atom)` and `update($, atom, fn)` are the exception.
- A render hook never writes state; write from handlers, timers or other events.
- Every `$.state` key must be declared in `types/index.d.ts`, which stays self-contained (no imports).
- A `Client`'s props are plain JSON (no `undefined`, no optional fields) and at most 100,000
  characters, which is why titles are cut to 200 characters.
- The engine's diff panel (`/diff` toggles it) takes the same dock as mod panes. While it shows,
  a mod pane is open with `isPlaced`/`isShown` true but never drawn: no `Pane` `ui.render` arrives.
  Hide the diff panel before you debug a pane that does not show.
- In the surface module, `setState` only from input handlers: three renders in a row that each call
  `setState` unmount the instance.
