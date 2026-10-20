import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Board, BoardMessage, BoardProps, BoardStatus, Detail, Priority, PriorityAction } from '../types'
import { detailOf } from './lib/detail'
import {
  fetchIssue,
  repoRoot,
  fetchPriorityField,
  fetchSnapshot,
  openIssue,
  readBranches,
  resolveRepo,
  writePriority,
  type Shell,
} from './lib/github'
import { claudeCommand, itermArgv, orcaArgv, orcaHandleOf, sessionName } from './lib/launch'
import {
  buildBoard,
  COLUMNS,
  DEFAULT_CONFIG,
  launchIn,
  nextPriority,
  priorityOf,
  type PriorityField,
  type Snapshot,
} from './lib/model'
import { drawPopup, popupTitle } from './popup'

const PANE = 'board'
/** The detail popup: a second pane, shown over the board while open. */
const POPUP = 'issue'
const LOCAL_POLL_MS = 3000
/** How long `p`/`P` wait after the last press before they write: the cycle is a roulette. */
const PRIORITY_DELAY_MS = 2000

const board = atom({ plugin: 'kanban-board', key: 'board' } as const, null)
const status = atom({ plugin: 'kanban-board', key: 'status' } as const, { isLoading: false, error: null })
const pick = atom({ plugin: 'kanban-board', key: 'pick' } as const, null)
const detail = atom({ plugin: 'kanban-board', key: 'detail' } as const, null)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isBoardMessage(data: unknown): data is BoardMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as { type?: unknown; number?: unknown }
  if (message.type === 'refresh') return true
  if (!Number.isInteger(message.number)) return false
  if (message.type === 'start') return true
  if (message.type === 'priority') {
    const { action } = data as { action?: unknown }
    return action === 'cycle' || action === 'clear'
  }
  return message.type === 'open' || message.type === 'detail'
}

/**
 * A Priority the board shows before GitHub says so. `readAfter` is the
 * refresh after which GitHub's answer holds it: null while the write runs.
 */
type Override = { priority: Priority | null; readAfter: number | null }

/** A session the board started (spec section 8); `terminal` is Orca's handle, null in iTerm. */
type SessionRecord = { sessionId: string; terminal: string | null; startedAt: number }

/** The records of one repository by issue number, kept in `$.store` under `sessions:<owner/repo>`. */
type Records = Record<string, SessionRecord[]>

/** The records kept per issue: the last few are enough to resume. */
const RECORDS_PER_ISSUE = 5

/** What the background work needs of the session, bound at `session.start`. */
type Host = Shell & {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  setBoard: (value: Board) => Promise<unknown>
  setStatus: (value: BoardStatus) => Promise<unknown>
  setDetail: (value: Detail) => Promise<unknown>
  updateDetail: (fn: (value: Detail | null) => Detail | null) => Promise<unknown>
  readStore: (key: string) => Promise<unknown>
  writeStore: (key: string, value: unknown) => Promise<void>
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
  // The board as last published: the column each card stands in.
  let lastBoard: Board | null = null
  let fetchedAt = 0
  let branches: string[] = []
  let timers: Timer[] = []
  let isRefreshing = false
  // Why the board's Client last failed; the pane then draws the reason instead.
  let fault: string | null = null
  // Grows with each issue the popup asks for: a slower, older load is dropped.
  let detailTicket = 0
  // The owner's Priority field: undefined until read, null when the owner has none.
  let priorityField: PriorityField | null | undefined
  let priorityError: string | null = null
  const overrides = new Map<number, Override>()
  // The writes of each issue run one after another, so the last write wins.
  const writes = new Map<number, Promise<void>>()
  // The presses of each issue not yet written: the value and override before the first of them,
  // and the timer that writes after the last.
  const bursts = new Map<number, { base: Priority | null; before: Override | undefined; timer: Timer }>()
  // Grows with each refresh that starts: what an override's `readAfter` counts in.
  let refreshes = 0
  // `TERM_PROGRAM` of this session: `Orca` starts cards in an Orca tab, anything else in iTerm.
  let termProgram: string | undefined
  // The sessions the board started, once read from the store; null until then.
  let records: Records | null = null
  // Cards being started: a second `s` before the tab opens does nothing.
  const starting = new Set<number>()
  // The node ids of issues the popup loaded that the board does not hold (containers' parents, old issues).
  const loadedIds = new Map<number, string>()

  const priorityOff = (): string | null => {
    if (priorityField !== undefined) {
      return priorityField === null ? `${repo?.split('/')[0] ?? 'the owner'} has no Priority issue field` : null
    }
    return priorityError === null ? 'Priority is not read yet' : `Priority could not be read: ${priorityError}`
  }

  const startedIssues = () => new Set(Object.keys(records ?? {}).map(Number))

  const loadRecords = async (to: Host, at: string): Promise<Records> => {
    const stored = await to.readStore(`sessions:${at}`)
    return typeof stored === 'object' && stored !== null ? (stored as Records) : {}
  }

  const publish = async (to: Host) => {
    if (snapshot === null) return
    const shown = new Map([...overrides].map(([number, one]) => [number, one.priority]))
    lastBoard = buildBoard(snapshot, branches, config, fetchedAt, {
      overrides: shown,
      priorityOff: priorityOff(),
      started: startedIssues(),
    })
    await to.setBoard(lastBoard)
  }

  const refresh = async (to: Host) => {
    if (isRefreshing) return
    isRefreshing = true
    try {
      await to.setStatus({ isLoading: true, error: null })
      repo ??= await resolveRepo(to, cwd)
      const now = await to.now()
      const started = ++refreshes
      const at = repo
      const field =
        priorityField !== undefined
          ? Promise.resolve()
          : fetchPriorityField(to, cwd, at).then(
              found => {
                priorityField = found
                priorityError = null
              },
              (error: unknown) => {
                priorityError = messageOf(error)
              },
            )
      records ??= await loadRecords(to, at)
      const [fetched, local] = await Promise.all([
        fetchSnapshot(to, cwd, at, config.doneDays, now),
        readBranches(to, cwd),
        field,
      ])
      snapshot = fetched
      fetchedAt = now
      branches = local
      // GitHub's answer now holds every write that ended before this refresh started.
      for (const [number, one] of overrides) {
        if (one.readAfter !== null && one.readAfter < started) overrides.delete(number)
      }
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
      const raw = await fetchIssue(to, cwd, repo, number)
      loadedIds.set(number, raw.id)
      const override = overrides.get(number)
      const issue = { ...detailOf(raw), ...(override === undefined ? {} : { priority: override.priority }) }
      if (ticket !== detailTicket) return
      await to.setDetail({ number, issue, isLoading: false, error: null })
      await to.openPopup(popupTitle(number, issue.title))
    } catch (error) {
      if (ticket === detailTicket) await to.setDetail({ number, issue: null, isLoading: false, error: messageOf(error) })
    }
  }

  /** The issue's Priority as the board shows it: a write not yet read back, else GitHub's. */
  const priorityNow = (number: number): Priority | null => {
    const override = overrides.get(number)
    if (override !== undefined) return override.priority
    const known = snapshot === null ? [] : [...snapshot.open, ...snapshot.done]
    const issue = known.find(one => one.number === number)
    if (issue !== undefined) return priorityOf(issue)
    return null
  }

  /** Shows `priority` on the card and in the popup at once, before GitHub has it. */
  const showPriority = async (to: Host, number: number, priority: Priority | null) => {
    await publish(to)
    await to.updateDetail(shown =>
      shown?.number === number && shown.issue !== null ? { ...shown, issue: { ...shown.issue, priority } } : shown,
    )
  }

  /**
   * `p` / `P` (spec section 4): the card moves at once; the write waits until
   * the presses stop for `PRIORITY_DELAY_MS`. A failed write puts the card
   * back and says why.
   */
  const changePriority = async (to: Host, number: number, action: PriorityAction, detailPriority: Priority | null) => {
    const field = priorityField
    if (field === undefined || field === null) {
      to.toast(priorityOff() ?? 'Priority is off')
      return
    }
    const known = snapshot === null ? [] : [...snapshot.open, ...snapshot.done]
    const issueId = known.find(one => one.number === number)?.id ?? loadedIds.get(number)
    if (issueId === undefined) {
      to.toast(`#${number} is not loaded yet`)
      return
    }
    const isKnown = overrides.has(number) || known.some(one => one.number === number)
    const current = isKnown ? priorityNow(number) : detailPriority
    const priority = nextPriority(current, action, field)
    if (priority === current) return

    const burst = bursts.get(number)
    burst?.timer.cancel()
    const mine: Override = { priority, readAfter: null }
    const before = burst === undefined ? overrides.get(number) : burst.before
    const base = burst === undefined ? current : burst.base
    bursts.set(number, {
      base,
      before,
      timer: to.after(PRIORITY_DELAY_MS, () => void writeLater(to, number, mine, issueId, field)),
    })
    overrides.set(number, mine)
    await showPriority(to, number, priority)
  }

  /** The write after the presses stopped; none when they came back to where they started. */
  const writeLater = async (to: Host, number: number, mine: Override, issueId: string, field: PriorityField) => {
    const burst = bursts.get(number)
    bursts.delete(number)
    if (burst === undefined || overrides.get(number) !== mine) return
    const { priority } = mine
    if (priority === burst.base) {
      if (burst.before === undefined) overrides.delete(number)
      else overrides.set(number, burst.before)
      await showPriority(to, number, priority)
      return
    }

    const previous = writes.get(number) ?? Promise.resolve()
    const write = previous.then(() => writePriority(to, cwd, issueId, field, priority))
    writes.set(number, write.catch(() => undefined))
    try {
      await write
      // A later press has its own override; this one is GitHub's from the next refresh on.
      if (overrides.get(number) === mine) mine.readAfter = refreshes
    } catch (error) {
      if (overrides.get(number) === mine) {
        overrides.delete(number)
        await showPriority(to, number, priorityNow(number))
      }
      to.toast(`Could not set the Priority of #${number}: ${messageOf(error)}`)
      void refresh(to)
    }
  }

  /**
   * `s` (spec section 7): a new interactive Claude session for the card in
   * the repository root, in a new Orca tab inside Orca and a new iTerm tab
   * elsewhere, with the prompt its labels call for. The board writes nothing
   * to GitHub; it records the session.
   */
  const startCard = async (to: Host, number: number) => {
    const card = lastBoard?.cards.find(one => one.number === number)
    if (snapshot === null || card === undefined || repo === null) {
      to.toast(`#${number} is not a card on the board`)
      return
    }
    const launch = launchIn(snapshot, number, card.column, config)
    if ('reason' in launch) {
      to.toast(launch.reason)
      return
    }
    if (starting.has(number)) return
    starting.add(number)
    const at = repo
    try {
      const root = await repoRoot(to, cwd)
      const sessionId = crypto.randomUUID()
      const name = sessionName(number, card.title)
      const command = claudeCommand(sessionId, name, launch.prompt)
      const inOrca = termProgram === 'Orca'
      const run = await to.run(inOrca ? orcaArgv(root, name, command) : itermArgv(root, command), {
        cwd: root,
        timeoutMs: 30_000,
      })
      if (run.exitCode !== 0) {
        throw new Error(run.stderr.trim().split('\n')[0] || `${inOrca ? 'orca' : 'osascript'} exited with ${run.exitCode}`)
      }
      const record: SessionRecord = {
        sessionId,
        terminal: inOrca ? orcaHandleOf(run.stdout) : null,
        startedAt: await to.now(),
      }
      // Read again: another board may have started a card since.
      const kept = await loadRecords(to, at)
      kept[String(number)] = [...(kept[String(number)] ?? []), record].slice(-RECORDS_PER_ISSUE)
      await to.writeStore(`sessions:${at}`, kept)
      records = kept
      await publish(to)
      to.toast(`Started #${number} in a new ${inOrca ? 'Orca' : 'iTerm'} tab: ${launch.prompt}`)
    } catch (error) {
      to.toast(`Could not start #${number}: ${messageOf(error)}`)
    } finally {
      starting.delete(number)
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
    termProgram = await $.env.get('TERM_PROGRAM').catch(() => undefined)
    host = {
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
    if (message.type === 'priority') void changePriority(to, message.number, message.action, null)
    if (message.type === 'start') void startCard(to, message.number)
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
    const current = await read($, board)
    const card = current?.cards.find(one => one.number === shown.number)
    const column = COLUMNS.find(one => one.id === card?.column)?.title ?? null
    const where = {
      columns: e.props.bodyColumns,
      column,
      priorityOff: current?.priorityOff ?? priorityOff(),
      startOff: card === undefined ? 'only a card on the board starts' : card.noStart,
    }

    return drawPopup(elements, shown, where, {
      select: number => {
        const to = host
        if (to !== null) void showIssue(to, number)
      },
      open: number => {
        const to = host
        if (to !== null) openInBrowser(to, number)
      },
      start: number => {
        const to = host
        if (to !== null) void startCard(to, number)
      },
      priority: (number, action) => {
        const to = host
        if (to !== null) void changePriority(to, number, action, shown.issue?.priority ?? null)
      },
    })
  })
}
