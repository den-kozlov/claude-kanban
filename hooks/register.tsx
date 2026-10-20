import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Board, BoardMessage, BoardProps, BoardStatus } from '../types'
import { fetchSnapshot, openIssue, readBranches, resolveRepo, type Shell } from './lib/github'
import { buildBoard, DEFAULT_CONFIG, type Snapshot } from './lib/model'

const PANE = 'board'
const LOCAL_POLL_MS = 3000

const board = atom({ plugin: 'kanban-board', key: 'board' } as const, null)
const status = atom({ plugin: 'kanban-board', key: 'status' } as const, { isLoading: false, error: null })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isBoardMessage(data: unknown): data is BoardMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as { type?: unknown; number?: unknown }
  return message.type === 'refresh' || (message.type === 'open' && Number.isInteger(message.number))
}

/** What the background work needs of the session, bound at `session.start`. */
type Host = Shell & {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  setBoard: (value: Board) => Promise<unknown>
  setStatus: (value: BoardStatus) => Promise<unknown>
  toast: (text: string) => void
}

export const register: Register = on => {
  const config = DEFAULT_CONFIG
  let host: Host | null = null
  let cwd = ''
  let repo: string | null = null
  let snapshot: Snapshot | null = null
  let fetchedAt = 0
  let branches: string[] = []
  let timers: Timer[] = []
  let isRefreshing = false
  // Why the board's Client last failed; the pane then draws the reason instead.
  let fault: string | null = null

  const publish = async (to: Host) => {
    if (snapshot !== null) await to.setBoard(buildBoard(snapshot, branches, config, fetchedAt))
  }

  const refresh = async (to: Host) => {
    if (isRefreshing) return
    isRefreshing = true
    try {
      await to.setStatus({ isLoading: true, error: null })
      repo ??= await resolveRepo(to, cwd)
      const now = await to.now()
      const [fetched, local] = await Promise.all([
        fetchSnapshot(to, cwd, repo, config.doneDays, now),
        readBranches(to, cwd),
      ])
      snapshot = fetched
      fetchedAt = now
      branches = local
      await publish(to)
      await to.setStatus({ isLoading: false, error: null })
    } catch (error) {
      // The last good board stays on screen.
      await to.setStatus({ isLoading: false, error: messageOf(error) })
    } finally {
      isRefreshing = false
    }
  }

  const pollLocal = async (to: Host) => {
    if (snapshot === null) return
    const local = await readBranches(to, cwd).catch(() => branches)
    if (local.join('\n') === branches.join('\n')) return
    branches = local
    await publish(to)
  }

  const start = () => {
    const to = host
    if (to === null || timers.length > 0) return
    timers = [
      to.every(config.refreshSeconds * 1000, () => void refresh(to)),
      to.every(LOCAL_POLL_MS, () => void pollLocal(to)),
    ]
    void refresh(to)
  }

  const stop = () => {
    for (const timer of timers) timer.cancel()
    timers = []
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    host = {
      run: (argv, init) => $.process.run(argv, init),
      sleep: ms => $.clock.sleep(ms),
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      setBoard: value => update($, board, () => value),
      setStatus: value => update($, status, () => value),
      toast: text => $.ui.toast(text),
    }
    await $.command.register({
      name: 'board',
      description: "Open or close the kanban board of this repository's GitHub issues",
    })
    // A reload keeps the pane open and drops the timers: start them again.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) start()

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      stop()
      return { text: 'Board closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Board', focus: true })
    start()

    return { text: opened.isPlaced ? 'Board opened.' : `The board waits: ${opened.reason}` }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    stop()
    return next(e)
  })

  on('ui.message', ($, e, next) => {
    const to = host
    if (e.requestId !== PANE || to === null || !isBoardMessage(e.data)) return next(e)
    const message = e.data
    if (message.type === 'refresh') void refresh(to)
    if (message.type === 'open' && repo !== null) {
      void openIssue(to, cwd, repo, message.number).catch(error => to.toast(messageOf(error)))
    }
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
      isFocused: e.props.isFocused,
      columns,
      rows,
    }

    return <Client key="board" module="./board.tsx" props={props} width={columns} height={rows} />
  })
}
