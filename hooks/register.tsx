import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Board, BoardMessage, BoardProps, BoardStatus, Detail, Priority, PriorityAction, SessionState } from '../types'
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
import {
  claudeCommand,
  focusArgv,
  ITERM_MISSING,
  itermArgv,
  itermIdOf,
  orcaArgv,
  orcaHandleOf,
  resumeCommand,
  sessionName,
} from './lib/launch'
import {
  buildBoard,
  DEFAULT_CONFIG,
  launchIn,
  nextPriority,
  priorityOf,
  type PriorityField,
  type Snapshot,
} from './lib/model'
import {
  HEARTBEAT_MS,
  issueSessionOf,
  recordsKey,
  recordsOf,
  reportKey,
  reportOf,
  STALE_MS,
  withRecord,
  withReopened,
  type Records,
  type Report,
  type Terminal,
} from './lib/sessions'

const PANE = 'board'
const LOCAL_POLL_MS = 3000
/** How long `p`/`P` wait after the last press before they write: the cycle is a roulette. */
const PRIORITY_DELAY_MS = 2000

/**
 * `$.state` outlives a reload, so a board the old code built would reach the new code's layout.
 * Change the tag whenever `Card` or `Board` changes: the new code then reads no board until it
 * builds one.
 */
const BOARD_SHAPE = 'stage-5'
const board = atom({ plugin: 'kanban-board', key: 'board' } as const, null, { shape: BOARD_SHAPE })
const status = atom({ plugin: 'kanban-board', key: 'status' } as const, { isLoading: false, error: null })
const pick = atom({ plugin: 'kanban-board', key: 'pick' } as const, null)
const detail = atom({ plugin: 'kanban-board', key: 'detail' } as const, null)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isBoardMessage(data: unknown): data is BoardMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as { type?: unknown; number?: unknown }
  if (message.type === 'refresh' || message.type === 'back') return true
  if (!Number.isInteger(message.number)) return false
  if (message.type === 'start') return true
  if (message.type === 'priority') {
    const { action, current } = data as { action?: unknown; current?: unknown }
    const isPriority = current === null || ['Urgent', 'High', 'Medium', 'Low'].includes(current as string)
    return (action === 'cycle' || action === 'clear') && isPriority
  }
  return message.type === 'open' || message.type === 'detail'
}

/**
 * A Priority the board shows before GitHub says so. `readAfter` is the
 * refresh after which GitHub's answer holds it: null while the write runs.
 */
type Override = { priority: Priority | null; readAfter: number | null }

/** A tab the board opened: in which app, and the id that brings it forward later. */
type Tab = { app: 'Orca' | 'iTerm'; terminal: Terminal | null }

/**
 * What a session the board started says of itself (spec section 8): its
 * state and the write that keeps its report fresh. `isInTurn` tells a tool
 * after a permission prompt (working again) from one after the turn.
 */
type Reporter = {
  state: Report['state']
  isInTurn: boolean
  write: () => Promise<void>
  timer: Timer
}

/** What the background work needs of the session, bound at `session.start`. */
type Host = Shell & {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  after: (ms: number, fn: () => void) => Timer
  setBoard: (value: Board) => Promise<unknown>
  setStatus: (value: BoardStatus) => Promise<unknown>
  setDetail: (value: Detail | null) => Promise<unknown>
  updateDetail: (fn: (value: Detail | null) => Detail | null) => Promise<unknown>
  readStore: (key: string) => Promise<unknown>
  writeStore: (key: string, value: unknown) => Promise<void>
  deleteStore: (key: string) => Promise<void>
  /** Asks the board to select the card. */
  pick: (number: number) => Promise<unknown>
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
  // Grows with each issue the detail view asks for: a slower, older load is dropped.
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
  // The sessions the board started, read from the store at each refresh; null until the first.
  let records: Records | null = null
  // The last report of each of those sessions, by record id: read with the branches.
  let reports = new Map<string, Report>()
  // The session states the board last showed, to publish again only when one changes.
  let shownSessions = ''
  // Cards being started, focused or resumed: a second `s` before the tab opens does nothing.
  const starting = new Set<number>()
  // This session's own report, when the board started it; null in every other session.
  let reporter: Reporter | null = null
  // The node ids of issues the detail view loaded that the board does not hold (containers' parents, old issues).
  const loadedIds = new Map<number, string>()

  const priorityOff = (): string | null => {
    if (priorityField !== undefined) {
      return priorityField === null ? `${repo?.split('/')[0] ?? 'the owner'} has no Priority issue field` : null
    }
    return priorityError === null ? 'Priority is not read yet' : `Priority could not be read: ${priorityError}`
  }

  const loadRecords = async (to: Host, at: string): Promise<Records> => recordsOf(await to.readStore(recordsKey(at)))

  /** The records changed as `change` says, read again first: another board may have written since. */
  const saveRecords = async (to: Host, at: string, change: (kept: Records) => Records) => {
    const kept = change(await loadRecords(to, at))
    await to.writeStore(recordsKey(at), kept)
    records = kept
  }

  const readReports = async (to: Host) => {
    const ids = Object.values(records ?? {}).flatMap(list => list.map(one => one.sessionId))
    const read = await Promise.all(ids.map(async id => [id, reportOf(await to.readStore(reportKey(id)))] as const))
    reports = new Map(read.flatMap(([id, report]) => (report === null ? [] : [[id, report] as const])))
  }

  const issueSession = (number: number, now: number) => issueSessionOf(records?.[String(number)] ?? [], reports, now)

  const sessionStates = (now: number) => {
    const states = new Map<number, SessionState>()
    for (const number of Object.keys(records ?? {}).map(Number)) {
      const state = issueSession(number, now)?.state
      if (state !== undefined) states.set(number, state)
    }
    return states
  }

  const publish = async (to: Host) => {
    if (snapshot === null) return
    const shown = new Map([...overrides].map(([number, one]) => [number, one.priority]))
    const sessions = sessionStates(await to.now())
    shownSessions = JSON.stringify([...sessions])
    lastBoard = buildBoard(snapshot, branches, config, fetchedAt, {
      overrides: shown,
      priorityOff: priorityOff(),
      sessions,
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
      records = await loadRecords(to, at)
      await readReports(to)
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

  /** The branches and the sessions' reports: the card moves when either changes. */
  const pollLocal = async (to: Host) => {
    if (snapshot === null) return
    const local = await readBranches(to, cwd).catch(() => branches)
    await readReports(to).catch(() => undefined)
    const sessions = JSON.stringify([...sessionStates(await to.now())])
    if (local.join('\n') === branches.join('\n') && sessions === shownSessions) return
    branches = local
    await publish(to)
  }

  /** Shows the issue in the detail view and selects it on the board, for when the view closes. */
  const showIssue = async (to: Host, number: number) => {
    const ticket = ++detailTicket
    await to.setDetail({ number, issue: null, isLoading: true, error: null })
    await to.pick(number)
    try {
      repo ??= await resolveRepo(to, cwd)
      const raw = await fetchIssue(to, cwd, repo, number)
      loadedIds.set(number, raw.id)
      const override = overrides.get(number)
      const issue = { ...detailOf(raw), ...(override === undefined ? {} : { priority: override.priority }) }
      if (ticket !== detailTicket) return
      await to.setDetail({ number, issue, isLoading: false, error: null })
    } catch (error) {
      if (ticket === detailTicket) await to.setDetail({ number, issue: null, isLoading: false, error: messageOf(error) })
    }
  }

  /** Back to the columns: a load still on its way is dropped. */
  const closeDetail = (to: Host) => {
    detailTicket += 1
    void to.setDetail(null)
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

  /** Shows `priority` on the card and in the detail view at once, before GitHub has it. */
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

  /** Opens a new tab in the repository root that runs `command`: in Orca inside Orca, in iTerm elsewhere. */
  const openTab = async (to: Host, root: string, name: string, command: string): Promise<Tab> => {
    const inOrca = termProgram === 'Orca'
    const run = await to.run(inOrca ? orcaArgv(root, name, command) : itermArgv(root, command), {
      cwd: root,
      timeoutMs: 30_000,
    })
    if (run.exitCode !== 0) {
      throw new Error(run.stderr.trim().split('\n')[0] || `${inOrca ? 'orca' : 'osascript'} exited with ${run.exitCode}`)
    }
    const id = inOrca ? orcaHandleOf(run.stdout) : itermIdOf(run.stdout)
    return {
      app: inOrca ? 'Orca' : 'iTerm',
      terminal: id === null ? null : { app: inOrca ? 'orca' : 'iterm', id },
    }
  }

  /** A new session with the prompt its labels call for; the board records it. */
  const startSession = async (to: Host, at: string, number: number, title: string, prompt: string) => {
    const root = await repoRoot(to, cwd)
    const sessionId = crypto.randomUUID()
    const name = sessionName(number, title)
    const tab = await openTab(to, root, name, claudeCommand(sessionId, name, prompt))
    const record = { sessionId, terminal: tab.terminal, startedAt: await to.now() }
    let dropped: string[] = []
    await saveRecords(to, at, kept => {
      const added = withRecord(kept, number, record)
      dropped = added.dropped
      return added.records
    })
    // A record that fell off the end takes its report along.
    for (const id of dropped) await to.deleteStore(reportKey(id)).catch(() => undefined)
    await publish(to)
    to.toast(`Started #${number} in a new ${tab.app} tab: ${prompt}`)
  }

  /** The issue's last session, in a new tab with `claude --resume`; it reports under its record again. */
  const resumeSession = async (to: Host, at: string, number: number, title: string) => {
    const session = issueSession(number, await to.now())
    if (session === null) throw new Error('the board started no session for it')
    const root = await repoRoot(to, cwd)
    const recordId = session.last.sessionId
    const tab = await openTab(to, root, sessionName(number, title), resumeCommand(recordId, session.resumeId))
    const now = await to.now()
    await saveRecords(to, at, kept => withReopened(kept, number, recordId, tab.terminal, now))
    await publish(to)
    to.toast(`Resumed #${number} in a new ${tab.app} tab`)
  }

  /** Brings the tab of the issue's running session forward. */
  const focusSession = async (to: Host, number: number) => {
    const terminal = issueSession(number, await to.now())?.live?.terminal ?? null
    if (terminal === null) throw new Error('the board does not know its tab')
    const run = await to.run(focusArgv(terminal), { cwd, timeoutMs: 30_000 })
    if (run.exitCode !== 0) {
      throw new Error(run.stderr.trim().split('\n')[0] || `${terminal.app === 'orca' ? 'orca' : 'osascript'} exited with ${run.exitCode}`)
    }
    if (terminal.app === 'iterm' && run.stdout.trim() === ITERM_MISSING) throw new Error('its iTerm tab is closed')
  }

  /**
   * `s` (spec section 7): a running session's tab comes forward; In progress
   * and Review resume the last session; the label columns start a new one with
   * the prompt their labels call for, in the repository root, in a new Orca tab
   * inside Orca and a new iTerm tab elsewhere. The board writes nothing to
   * GitHub; it records the sessions it starts.
   */
  const startCard = async (to: Host, number: number) => {
    const card = lastBoard?.cards.find(one => one.number === number)
    if (snapshot === null || card === undefined || repo === null) {
      to.toast(`#${number} is not a card on the board`)
      return
    }
    const launch = launchIn(snapshot, number, card.column, config, card.session)
    if (launch.kind === 'none') {
      to.toast(launch.reason)
      return
    }
    if (starting.has(number)) return
    starting.add(number)
    const at = repo
    try {
      if (launch.kind === 'focus') await focusSession(to, number)
      if (launch.kind === 'resume') await resumeSession(to, at, number, card.title)
      if (launch.kind === 'start') await startSession(to, at, number, card.title, launch.prompt)
    } catch (error) {
      to.toast(`Could not ${launch.kind} #${number}: ${messageOf(error)}`)
    } finally {
      starting.delete(number)
    }
  }

  /** Records this session's state for the board, when the board started it and the state changed. */
  const report = (state: Report['state']) => {
    if (reporter === null || reporter.state === state) return
    reporter.state = state
    void reporter.write()
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
    // The board opens again on its columns.
    if (host !== null) closeDetail(host)
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
      deleteStore: key => $.store.delete(key),
      pick: number => update($, pick, old => ({ number, seq: (old?.seq ?? 0) + 1 })),
      toast: text => $.ui.toast(text),
    }
    await $.command.register({
      name: 'board',
      description: "Open or close the kanban board of this repository's GitHub issues",
    })
    // A reload keeps the pane open and drops the timers: start them again.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) start()

    // The reporter (spec section 8): a session the board started finds its record id in the
    // environment, and writes its state under it until it ends.
    reporter = null
    const recordId = e.isInteractive ? await $.env.get('KANBAN_BOARD_SESSION').catch(() => undefined) : undefined
    if (recordId !== undefined && recordId !== '') {
      const key = reportKey(recordId)
      const previous = reportOf(await $.store.get(key).catch(() => undefined))
      const now = await $.clock.now()
      // A reload runs this again mid-turn: keep what the session said last.
      const isFresh = previous !== null && previous.state !== 'ended' && now - previous.at < STALE_MS
      let writes = Promise.resolve()
      const write = () => {
        // One write after another, each with the state at its turn: the last one written is the newest.
        writes = writes
          .then(async () => {
            const value: Report = { state: mine.state, at: await $.clock.now(), sessionId: await $.session.id() }
            await $.store.set(key, value)
          })
          .catch(() => undefined)
        return writes
      }
      const mine: Reporter = {
        state: isFresh ? previous.state : 'waiting',
        isInTurn: isFresh && previous.state === 'working',
        write,
        timer: $.clock.every(HEARTBEAT_MS, () => void write()),
      }
      reporter = mine
      void write()
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (reporter !== null && e.agentId === undefined) {
      reporter.isInTurn = true
      report('working')
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (reporter !== null && e.agentId === undefined) {
      reporter.isInTurn = false
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
    if (reporter?.isInTurn === true) report('working')
    return next(e)
  })
    .catch(() => undefined)

  on('session.end', async ($, e, next) => {
    const mine = reporter
    // After a `/clear` the process goes on under a new id, the same tab, the same issue.
    if (mine !== null && e.reason !== 'clear') {
      mine.timer.cancel()
      mine.state = 'ended'
      await mine.write()
    }
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      stop()
      return { text: 'Board closed.' }
    }
    // A board opened again draws its `Client` again, past a failure that is gone.
    fault = null
    $.ui.invalidate('ui.render')
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
    if (message.type === 'back') closeDetail(to)
    if (message.type === 'priority') void changePriority(to, message.number, message.action, message.current)
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
      detail: await read($, detail),
      columns,
      rows,
    }

    return <Client key="board" module="./board.tsx" props={props} width={columns} height={rows} />
  })
}
