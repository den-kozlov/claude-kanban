# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod (a plugin of function hooks) named `kanban-board`: a kanban board of the current
repository's GitHub issues in a pane beside the transcript, opened and closed with `/board`. The
design is `docs/spec.md`; its section 12 is the delivery plan and a table of what is built.
Stages 1 (read-only board), 2 (detail view), 3 (Priority writes), 4 (starting cards), 5
(session tracking), 6 (the config file), 7 (the terminal board, `bin/kanban-board`) and 8 (`s` in
the current session, `S` in a new one) are built.

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
- `npx -p typescript tsc -p tui` — type-check the terminal board (Node APIs from `tui/node.d.ts`).
- `bin/kanban-board [folder]` — the terminal board. Bun compiles JSX with the tsconfig of the folder
  it runs in, so the launcher runs `bun tui/main.ts` in the plugin's folder; elsewhere the board
  says so and quits.
- `claude --plugin-dir . --debug` — run a session with the mod loaded; edits hot-reload.

The API declarations (`.claude-plugin/types/claude-code/index.d.ts`) are the authority on every
event, `$` noun and element prop; grep them rather than guessing.

## Architecture

Two runtimes talk through messages:

- `hooks/register.tsx`, the hooks module. It registers `/board`, opens and closes the `board` pane,
  binds a `Host` to `$` and hands it to the controller (`hooks/lib/controller.ts`), which does the
  background work. The `Host`'s `here` runs a card's prompt in this session (a slash command
  through `$.command.run`, other text through `$.prompt.submit`). Its `ui.render` hook for the pane
  only hands the `$.state` the controller writes as props to a `Client`. The same module is the
  reporter in every session: one whose environment has `KANBAN_BOARD_SESSION` (the board puts it
  in the tab's command), or in which `s` started cards (their record ids in the `here` state),
  writes its state to `$.store` under `live:<record id>`, and the board reads it with the branches.
- `hooks/lib/controller.ts`, the board's background work, with no `$`: it keeps the data fresh while
  the board is open (GitHub every 60 s, local branches every 3 s) and writes the built board and
  the refresh status through the `Host`. It loads the issue the detail view shows into the
  `detail` state (null: the columns), and sets the `pick` state, which the board takes as its
  selection once. It writes Priority (`p`/`P`): the new value shows at once as an
  override over GitHub's, kept until a refresh that started after the write ended. It starts cards:
  `s` (`where: 'here'`) in the session the board runs in, `S` (`'new'`, and `s` in the terminal
  board, whose `Host` has no `here`) as a new `claude` in an Orca or iTerm tab; both recorded in
  `$.store`. On a card with a session, both focus a running session's tab and resume an ended one.
  `handle` takes what the board posts.
- `hooks/board.tsx`, the `Client`'s surface module. It runs on the drawing thread with no `$`. It owns
  what belongs to the viewer: the selection, Done shown or hidden, the container filter, each
  column's scroll window and where the detail view is scrolled to. It draws the detail view in
  place of the columns while `detail` is set. It handles raw keys and pointer events, and posts
  `refresh` / `open` / `detail` / `back` / `priority` / `start` to the hooks module (`ui.message`).
  Keys reach it only after the person clicks the board.
- `tui/`, the terminal board: the same `board.tsx` and controller outside Claude Code, on Bun.
  `client.ts` is a `Client` surface (state, keys, pointer, `post`) over `render.ts`, which lays out
  and paints the `Box`/`Text` subset the board uses as ANSI lines; `keys.ts` reads raw stdin
  (keys, SGR mouse); `host.ts` is the `Host` on Node; `store.ts` reads and writes the mod's
  `$.store` file (`<config dir>/plugins/store/kanban-board_*.json`) with a rename per set.
  `board.tsx` and the controller serve both: keep them free of what only one runtime has.

Pure logic, shared by both and covered by the tests:

- `hooks/lib/model.ts` — the column rules and their precedence, PR and branch matching, card order,
  the Priority field by name and the `p` cycle.
- `hooks/lib/layout.ts` — the cell-exact layout: side-by-side or stacked columns, collapse to
  one-line rows, scroll windows, arrow navigation, hit testing. The surface module draws exactly
  these rows, so every text is cut by `hooks/lib/text.ts`, never wrapped by the terminal.
- `hooks/lib/github.ts` — the `gh api graphql` queries and Priority mutations (own pagination,
  retry with backoff for the `EOF` failures) and the git reads.
- `hooks/lib/detail.ts` — the detail view's issue from GitHub's answer; Markdown cleaned and cut.
- `hooks/lib/detail-view.ts` — the detail view's lines, cut to the cell, and its links.
- `hooks/lib/launch.ts` — what `s` / `S` do for a card (start with which prompt, focus, resume, or
  why nothing), a prompt's slash command, and the `orca` / `osascript` commands with their shell quoting.
- `hooks/lib/config.ts` — `.claude/kanban.json` over `DEFAULT_CONFIG`, part by part, and what is
  wrong with it. The hooks module reads the file at each refresh.
- `hooks/lib/sessions.ts` — the session records and reports in `$.store`, and a session's state
  from them (starting, working, waiting, ended).

## Platform rules that bite

- `$` may appear only as `$.noun.method(...)` at a call site: never assign it, pass it to a function
  or return it (the validator refuses the module). Work outside a hook goes through closures bound in
  `session.start` (the `Host` object in `register.tsx`; `Shell` in `github.ts`). The state helpers
  `read($, atom)` and `update($, atom, fn)` are the exception.
- A render hook never writes state; write from handlers, timers or other events.
- `$.state` outlives a reload, so the new code first reads what the old code wrote. The `board`
  atom carries a shape tag (`BOARD_SHAPE` in `register.tsx`): change it with every change to
  `Card` or `Board`, or the layout gets a card without the new fields and the pane shows
  "The board failed" until `/board` opens it again.
- A reload swaps the surface module and the hooks module apart: the new `board.tsx` may draw once
  with the old module's props. Read a new `BoardProps` field as possibly absent (`?? null`).
- Every `$.state` key must be declared in `types/index.d.ts`, which stays self-contained (no imports).
- A `Client`'s props are plain JSON (no `undefined`, no optional fields) and at most 100,000
  characters, which is why titles are cut to 200 characters.
- The engine's diff panel (`/diff` toggles it) takes the same dock as mod panes. While it shows,
  a mod pane is open with `isPlaced`/`isShown` true but never drawn: no `Pane` `ui.render` arrives.
  Hide the diff panel before you debug a pane that does not show.
- `$.store` is one JSON file per plugin, read again on each get and locked for each set, so
  concurrent sessions share it. Give each key one writer: the board writes `sessions:<repo>`, each
  session its own `live:<id>`.
- Never open a second pane that takes the keys from the board: a `Client` gets them only from
  a click, nothing gives them back, and `Escape` never reaches it. Draw in the board's `Client`.
- In the surface module, `setState` only from input handlers: three renders in a row that each call
  `setState` unmount the instance.
