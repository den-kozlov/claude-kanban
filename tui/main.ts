// The terminal board: the same board as the `/board` pane, in a terminal of
// its own, no Claude Code session needed. The board's surface module
// (hooks/board.tsx) draws and takes the keys through `client.ts`; the board's
// background work (hooks/lib/controller.ts) runs on Node through `host.ts`.
//
//   bin/kanban-board [folder]
//
// Bun compiles JSX with the tsconfig.json of the folder it runs in: the
// launcher runs it in the plugin's folder, where that is `h`.

import { resolve } from 'node:path'
import type { JsonValue } from 'claude-code'

import Board from '../hooks/board'
import { createController, isBoardMessage } from '../hooks/lib/controller'
import { isInOrca } from '../hooks/lib/launch'
import { truncate } from '../hooks/lib/text'
import type { BoardProps } from '../types'
import { mount } from './client'
import { nodeHost, type BoardData } from './host'
import { parse } from './keys'
import { Fragment, gridOf, h, linesOf, put, type Grid } from './render'
import { findStore, storeAt } from './store'

const HELP = `kanban-board: the kanban board of a repository's GitHub issues, in the terminal.

Usage: kanban-board [folder]

  folder   a folder of the repository (the current one by default)

The keys are the pane's (see the README); Esc goes back from the detail view
and closes the filter, q or Ctrl-C quits. The board needs \`gh\` signed in.
KANBAN_BOARD_STORE names the mod's store file when the newest one is not it.
`

/** How long a toast stays in the bottom line. */
const TOAST_MS = 6000
/** The bottom line under the board: the toasts, and how to quit. */
const FOOTER_ROWS = 1

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h'
const LEAVE = '\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l'

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP)
    return
  }
  // Compiled in another folder, the module calls React's JSX runtime, not `h`.
  if (/\bjsx(DEV)?_?\w*\(/.test(String(Board))) {
    process.stderr.write('kanban-board: run the board with bin/kanban-board, or with bun in the plugin\'s folder\n')
    process.exitCode = 1
    return
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write('kanban-board: the board needs a terminal\n')
    process.exitCode = 1
    return
  }
  const cwd = resolve(args[0] ?? process.cwd())

  // The board's module compiles its JSX against these, as the engine's globals.
  Object.assign(globalThis, { h, Fragment })

  const found = await findStore(process.env)
  const store = storeAt(found.path, found.isShared, process.pid)
  const logs: string[] = []
  let toast: { text: string; until: number } | null = null
  const data: BoardData = { board: null, status: { isLoading: false, error: null }, pick: null, detail: null }

  // Something changed since the last draw; one draw a frame at most.
  let isDirty = false
  const changed = () => {
    if (isDirty) return
    isDirty = true
    setTimeout(() => {
      if (isDirty) draw()
    }, 16)
  }

  const controller = createController()
  const host = nodeHost(store, {
    data,
    changed,
    toast: text => {
      toast = { text, until: Date.now() + TOAST_MS }
      setTimeout(changed, TOAST_MS + 50)
      changed()
    },
    log: text => logs.push(text),
  })
  const board = mount<BoardProps, unknown>(
    Board as never,
    (message: JsonValue) => {
      if (isBoardMessage(message)) controller.handle(message)
    },
    changed,
  )

  let shown: string[] = []
  const draw = () => {
    isDirty = false
    const columns = Math.max(1, process.stdout.columns)
    const rows = Math.max(FOOTER_ROWS + 1, process.stdout.rows)
    const height = rows - FOOTER_ROWS
    // No session here: `s` starts a card in a new one, as `S` does.
    const grid = board.draw({ ...data, startsHere: false, columns, rows: height }, columns, height)
    const lines = [...linesOf(grid), ...linesOf(footer(columns))]
    let out = '\x1b[?2026h'
    lines.forEach((line, index) => {
      if (shown[index] !== line) out += `\x1b[${index + 1};1H${line}`
    })
    shown = lines
    process.stdout.write(`${out}\x1b[?2026l`)
  }

  const footer = (columns: number): Grid => {
    const grid = gridOf(columns, FOOTER_ROWS)
    const hint = 'q quit'
    const plain = { color: null, dim: true, bold: false, inverse: false }
    put(grid, Math.max(0, columns - hint.length), 0, hint, plain)
    if (toast !== null && toast.until > Date.now()) {
      put(grid, 0, 0, truncate(toast.text, columns - hint.length - 2), { ...plain, color: 'warning', dim: false })
    }
    return grid
  }

  let isLeft = false
  const leave = async (code: number) => {
    if (isLeft) return
    isLeft = true
    // A Priority shown but not written yet: write it before the board goes.
    await Promise.race([controller.flush(), new Promise(resolve => setTimeout(() => resolve(null), 15_000))])
    controller.stop()
    process.stdin.setRawMode(false)
    process.stdout.write(LEAVE)
    for (const line of logs) process.stderr.write(`${line}\n`)
    process.exit(code)
  }
  process.on('SIGTERM', () => void leave(0))
  process.on('SIGHUP', () => void leave(0))
  process.on('uncaughtException', (error: Error) => {
    logs.push(`kanban-board: ${error.stack ?? error.message}`)
    void leave(1)
  })

  process.stdout.write(`${ENTER}\x1b[2J`)
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    for (const input of parse(chunk)) {
      if (input.kind === 'key') {
        const { key, ctrl, meta } = input.event
        if ((key === 'c' && ctrl === true) || (key === 'q' && ctrl === undefined && meta === undefined)) void leave(0)
        else board.key(input.event)
      }
      if (input.kind === 'wheel') board.key({ key: input.step < 0 ? 'up' : 'down' })
      // The bottom line is not the board's.
      if (input.kind === 'pointer' && input.event.y < process.stdout.rows - FOOTER_ROWS) board.pointer(input.event)
      // The module answers the next key from what it drew last: draw what this one changed first.
      if (isDirty) draw()
    }
  })
  process.stdin.resume()
  process.stdout.on('resize', () => {
    shown = []
    process.stdout.write('\x1b[2J')
    changed()
  })

  if (!store.isShared) {
    host.toast('No Claude Code session has run the mod yet: the board will not see the state of the sessions it starts')
  }
  controller.attach(host, cwd, isInOrca(process.env.TERM_PROGRAM, process.env.ORCA_TERMINAL_HANDLE))
  controller.start()
  draw()
}

void main()
