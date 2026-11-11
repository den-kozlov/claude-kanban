import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { BoardProps } from '../types'
import { createController, isBoardMessage, type Host } from './lib/controller'
import { isInOrca, slashOf } from './lib/launch'
import { HEARTBEAT_MS, reportKey, reportOf, STALE_MS, type Report } from './lib/sessions'

const PANE = 'board'

/**
 * `$.state` outlives a reload, so a board the old code built would reach the new code's layout.
 * Change the tag whenever `Card` or `Board` changes: the new code then reads no board until it
 * builds one.
 */
const BOARD_SHAPE = 'stage-6'
const board = atom({ plugin: 'kanban-board', key: 'board' } as const, null, { shape: BOARD_SHAPE })
const status = atom({ plugin: 'kanban-board', key: 'status' } as const, { isLoading: false, error: null })
const pick = atom({ plugin: 'kanban-board', key: 'pick' } as const, null)
const detail = atom({ plugin: 'kanban-board', key: 'detail' } as const, null)
const here = atom({ plugin: 'kanban-board', key: 'here' } as const, [])
const left = atom({ plugin: 'kanban-board', key: 'left' } as const, [])

/**
 * What a session the board started says of itself (spec section 8): its
 * state, the record ids it writes it under and the write that keeps them fresh.
 */
type Reporter = {
  state: Report['state']
  recordIds: string[]
  write: () => Promise<void>
  timer: Timer
}

/** A write of `state` under fixed record ids; `sessionId`, the id it names (else the session's own now). */
type Fixed = { state: Report['state']; recordIds: string[]; sessionId?: string }

export const register: Register = on => {
  // The refresh, the detail view, the Priority writes and starting cards: the terminal board runs the same.
  const controller = createController()
  // Why the board's Client last failed; the pane then draws the reason instead.
  let fault: string | null = null
  // This session's own report, when the board started it or `s` started a card in it; null in every other session.
  let reporter: Reporter | null = null
  // Whether the main loop's turn runs: a tool after a permission prompt is working again, one after the turn is not.
  let isInTurn = false
  // Ends this session's reports under the record ids (all of them by default), the last one written `ended`; bound at `session.start`.
  let leave: (recordIds?: string[], sessionId?: string) => Promise<void> = async () => undefined

  /** Records this session's state for the board, when the board started it and the state changed. */
  const report = (state: Report['state']) => {
    if (reporter === null || reporter.state === state) return
    reporter.state = state
    void reporter.write()
  }

  on('session.start', async ($, e, next) => {
    reporter?.timer.cancel()
    reporter = null
    let writes = Promise.resolve()
    const write = (fixed?: Fixed) => {
      // One write after another, each with the state at its turn: the last one written is the newest.
      writes = writes
        .then(async () => {
          const mine = fixed ?? reporter
          if (mine === null) return
          const value: Report = { state: mine.state, at: await $.clock.now(), sessionId: fixed?.sessionId ?? (await $.session.id()) }
          for (const id of mine.recordIds) await $.store.set(reportKey(id), value)
        })
        .catch(() => undefined)
      return writes
    }
    /** Reports under the record ids too, from `state` on when this session reported nothing yet. */
    const reportUnder = (recordIds: string[], state: Report['state']) => {
      reporter ??= { state, recordIds: [], write: () => write(), timer: $.clock.every(HEARTBEAT_MS, () => void write()) }
      reporter.recordIds = [...new Set([...reporter.recordIds, ...recordIds])]
      return write()
    }
    leave = async (recordIds, sessionId) => {
      const mine = reporter
      const gone = mine?.recordIds.filter(id => recordIds?.includes(id) ?? true) ?? []
      if (mine === null || gone.length === 0) return
      mine.recordIds = mine.recordIds.filter(id => !gone.includes(id))
      if (mine.recordIds.length === 0) {
        mine.timer.cancel()
        reporter = null
      }
      // The report first: a session that exits may not get to the rest.
      await write({ state: 'ended', recordIds: gone, sessionId })
      // After a reload too: `session.start` reads `KANBAN_BOARD_SESSION` again, but not these.
      await update($, here, ids => ids.filter(id => !gone.includes(id)))
      await update($, left, ids => [...new Set([...ids, ...gone])])
    }

    const host: Host = {
      run: (argv, init) => $.process.run(argv, init),
      sleep: ms => $.clock.sleep(ms),
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      after: (ms, fn) => $.clock.after(ms, fn),
      setBoard: value => update($, board, () => value),
      setStatus: value => update($, status, () => value),
      setDetail: value => update($, detail, () => value),
      updateDetail: fn => update($, detail, fn),
      readStore: key => $.store.get(key),
      writeStore: (key, value) => $.store.set(key, value),
      deleteStore: key => $.store.delete(key),
      pick: number => update($, pick, old => ({ number, seq: (old?.seq ?? 0) + 1 })),
      toast: text => $.ui.toast(text),
      log: text => $.ui.log(text),
      readText: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : null),
      here: {
        // As if the person typed it: a slash command runs as one, other text is their prompt.
        submit: async text => {
          const slash = slashOf(text)
          if (slash !== null) {
            await $.command.run(slash)
            return
          }
          const entered = await $.prompt.submit({ text, asUser: true })
          if (entered.drop !== undefined) throw new Error(entered.drop)
        },
        // One card at a time: the one it worked on before ends.
        track: async recordId => {
          await leave()
          await update($, here, () => [recordId])
          await reportUnder([recordId], isInTurn ? 'working' : 'waiting')
        },
        untrack: recordId => leave([recordId]),
        isTracked: recordId => reporter?.recordIds.includes(recordId) === true,
      },
    }
    const termProgram = await $.env.get('TERM_PROGRAM').catch(() => undefined)
    const orcaTerminal = await $.env.get('ORCA_TERMINAL_HANDLE').catch(() => undefined)
    controller.attach(host, e.cwd, isInOrca(termProgram, orcaTerminal))
    await $.command.register({
      name: 'board',
      description: "Open or close the kanban board of this repository's GitHub issues",
    })
    // A reload keeps the pane open and drops the timers: start them again.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) controller.start()

    // The reporter (spec section 8): a session the board started finds its record id in the
    // environment, a session `s` started a card in finds its own in `$.state` (after a reload);
    // it writes its state under each until it ends, a `/clear` or another card's `s` ends it, or `x`.
    const recordId = e.isInteractive ? await $.env.get('KANBAN_BOARD_SESSION').catch(() => undefined) : undefined
    const gone = await read($, left)
    const recordIds = [...(recordId === undefined || recordId === '' ? [] : [recordId]), ...(await read($, here))].filter(
      id => !gone.includes(id),
    )
    if (recordIds.length > 0) {
      const previous = reportOf(await $.store.get(reportKey(recordIds[0] as string)).catch(() => undefined))
      const now = await $.clock.now()
      // A reload runs this again mid-turn: keep what the session said last.
      const isFresh = previous !== null && previous.state !== 'ended' && now - previous.at < STALE_MS
      isInTurn = isFresh && previous.state === 'working'
      void reportUnder(recordIds, isFresh ? previous.state : 'waiting')
    }

    return next(e)
  })

  // Subagents' turns are not the session's.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      isInTurn = true
      report('working')
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      isInTurn = false
      report('waiting')
    }
    return next(e)
  })

  // A permission prompt waits for the person; the tool's end means they answered.
  on('classic.PermissionRequest', ($, e, next) => {
    report('waiting')
    return next(e)
  })
    // A report is never worth a tool call: a failure leaves the call to the hooks beneath.
    .catch(() => undefined)

  on('classic.PostToolUse', ($, e, next) => {
    if (isInTurn) report('working')
    return next(e)
  })
    .catch(() => undefined)

  // Any end, a `/clear` too: the conversation that knew the card is gone. The report names the
  // ending session, the one `claude --resume` returns to the card in.
  on('session.end', async ($, e, next) => {
    await leave(undefined, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      controller.stop()
      return { text: 'Board closed.' }
    }
    // A board opened again draws its `Client` again, past a failure that is gone.
    fault = null
    $.ui.invalidate('ui.render')
    const opened = await $.ui.open({ id: PANE, title: 'Board', focus: true })
    controller.start()

    return { text: opened.isPlaced ? 'Board opened.' : `The board waits: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    controller.stop()
    return next(e)
  })

  on('ui.message', ($, e, next) => {
    if (e.requestId !== PANE || !isBoardMessage(e.data)) return next(e)
    controller.handle(e.data)
    return next(e)
  })

  on('ui.fault', ($, e, next) => {
    fault = `${e.phase}: ${e.reason}`
    $.ui.log(`kanban-board: the board failed (${fault})`)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (fault !== null) {
      const { Text } = $.ui.resolve(e)
      return <Text color="error">The board failed: {fault}</Text>
    }
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>The board draws in the terminal and the desktop app.</Text>
    }
    const { Client } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const props: BoardProps = {
      board: await read($, board),
      status: await read($, status),
      pick: await read($, pick),
      detail: await read($, detail),
      startsHere: true,
      columns,
      rows,
    }

    return <Client key="board" module="./board.tsx" props={props} width={columns} height={rows} />
  })
}
