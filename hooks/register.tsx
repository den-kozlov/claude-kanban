import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Board, BoardMessage, BoardProps, BoardStatus, Detail } from '../types'
import { detailOf } from './lib/detail'
import { fetchIssue, fetchSnapshot, openIssue, readBranches, resolveRepo, type Shell } from './lib/github'
import { buildBoard, COLUMNS, DEFAULT_CONFIG, type Snapshot } from './lib/model'
import { drawPopup, popupTitle } from './popup'

const PANE = 'board'
/** The detail popup: a second pane, shown over the board while open. */
const POPUP = 'issue'
const LOCAL_POLL_MS = 3000

const board = atom({ plugin: 'kanban-board', key: 'board' } as const, null)
const status = atom({ plugin: 'kanban-board', key: 'status' } as const, { isLoading: false, error: null })
const pick = atom({ plugin: 'kanban-board', key: 'pick' } as const, null)
const detail = atom({ plugin: 'kanban-board', key: 'detail' } as const, null)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isBoardMessage(data: unknown): data is BoardMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as { type?: unknown; number?: unknown }
  if (message.type === 'refresh') return true
  return (message.type === 'open' || message.type === 'detail') && Number.isInteger(message.number)
}

/** What the background work needs of the session, bound at `session.start`. */
type Host = Shell & {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  setBoard: (value: Board) => Promise<unknown>
  setStatus: (value: BoardStatus) => Promise<unknown>
  setDetail: (value: Detail) => Promise<unknown>
  /** Asks the board to select the card. */
  pick: (number: number) => Promise<unknown>
  /** Opens the popup, or retitles it when it is open. */
  openPopup: (title: string) => Promise<unknown>
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
  // Grows with each issue the popup asks for: a slower, older load is dropped.
  let detailTicket = 0

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

  /** Shows the issue in the popup (opening it) and selects it on the board. */
  const showIssue = async (to: Host, number: number) => {
    const ticket = ++detailTicket
    const known = snapshot === null ? [] : [...snapshot.open, ...snapshot.done]
    const title = known.find(one => one.number === number)?.title ?? null
    await to.setDetail({ number, issue: null, isLoading: true, error: null })
    await to.pick(number)
    await to.openPopup(popupTitle(number, title))
    try {
      repo ??= await resolveRepo(to, cwd)
      const issue = detailOf(await fetchIssue(to, cwd, repo, number))
      if (ticket !== detailTicket) return
      await to.setDetail({ number, issue, isLoading: false, error: null })
      await to.openPopup(popupTitle(number, issue.title))
    } catch (error) {
      if (ticket === detailTicket) await to.setDetail({ number, issue: null, isLoading: false, error: messageOf(error) })
    }
  }

  const openInBrowser = (to: Host, number: number) => {
    const at = repo
    if (at !== null) void openIssue(to, cwd, at, number).catch(error => to.toast(messageOf(error)))
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
      setDetail: value => update($, detail, () => value),
      pick: number => update($, pick, old => ({ number, seq: (old?.seq ?? 0) + 1 })),
      openPopup: title => $.ui.open({ id: POPUP, title, focus: true, closeOnEscape: true }),
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
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      if (panes.some(pane => pane.id === POPUP)) await $.ui.close({ id: POPUP })
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
    if (message.type === 'open') openInBrowser(to, message.number)
    if (message.type === 'detail') void showIssue(to, message.number)
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
      isFocused: e.props.isFocused,
      columns,
      rows,
    }

    return <Client key="board" module="./board.tsx" props={props} width={columns} height={rows} />
  })

  on('ui.render', { component: 'Pane', requestId: POPUP }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const shown = await read($, detail)
    if (shown === null) {
      const { Text } = elements
      return <Text dimColor>No issue chosen.</Text>
    }
    const card = (await read($, board))?.cards.find(one => one.number === shown.number)
    const column = COLUMNS.find(one => one.id === card?.column)?.title ?? null

    return drawPopup(elements, shown, { columns: e.props.bodyColumns, column }, {
      select: number => {
        const to = host
        if (to !== null) void showIssue(to, number)
      },
      open: number => {
        const to = host
        if (to !== null) openInBrowser(to, number)
      },
    })
  })
}
