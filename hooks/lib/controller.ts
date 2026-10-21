// The board's background work, apart from the engine: the refresh from GitHub
// and the poll of the branches, the detail view's issue, the Priority writes
// and starting cards. It reaches the world only through the `Host` it is
// attached to: the hooks module binds one to `$` at `session.start`, the
// terminal board (`tui/`) one to Node. No `$` here.

import type { Timer } from 'claude-code'

import type { Board, BoardMessage, BoardStatus, Detail, Priority, PriorityAction, SessionState, StartWhere } from '../../types'
import { CONFIG_PATH, configOf } from './config'
import { detailOf } from './detail'
import {
  fetchIssue,
  repoRoot,
  fetchPriorityField,
  fetchSnapshot,
  openIssue,
  readBranches,
  resolveRepo,
  worktreeRoot,
  writePriority,
  type Shell,
} from './github'
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
} from './launch'
import {
  buildBoard,
  DEFAULT_CONFIG,
  type Config,
  launchIn,
  nextPriority,
  priorityOf,
  type PriorityField,
  type Snapshot,
} from './model'
import {
  issueSessionOf,
  recordsKey,
  recordsOf,
  reportKey,
  reportOf,
  withRecord,
  withReopened,
  type Records,
  type Report,
  type SessionRecord,
  type Terminal,
} from './sessions'

const LOCAL_POLL_MS = 3000
/** How long `p`/`P` wait after the last press before they write: the cycle is a roulette. */
const PRIORITY_DELAY_MS = 2000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function isBoardMessage(data: unknown): data is BoardMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as { type?: unknown; number?: unknown }
  if (message.type === 'refresh' || message.type === 'back') return true
  if (!Number.isInteger(message.number)) return false
  if (message.type === 'start') {
    // A board older than `where` posts none: it starts in a new tab.
    const { where } = data as { where?: unknown }
    return where === undefined || where === 'here' || where === 'new'
  }
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

/** What the background work needs of its runtime: the session's `$`, or Node in the terminal board. */
export type Host = Shell & {
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
  log: (text: string) => void
  /** The file's text; null when there is no such file. */
  readText: (path: string) => Promise<string | null>
  /** The session the board runs in, where `s` starts a card; absent in the terminal board, which has none. */
  here?: Here
}

/** What `s` needs of the session the board runs in (spec section 7). */
export type Here = {
  /** Runs `text` as if the person typed it: a slash command, or their prompt; rejects when the session refuses it. */
  submit: (text: string) => Promise<void>
  /** The session reports its state under `recordId` from now on, a reload included (spec section 8). */
  track: (recordId: string) => Promise<void>
  /** Whether the session reports under `recordId`. */
  isTracked: (recordId: string) => boolean
}

/** The board's background work; `attach` gives it the runtime to work through. */
export type Controller = {
  /** The runtime, the folder the board is for and whether it runs inside Orca (`isInOrca`). */
  attach: (host: Host, cwd: string, inOrca: boolean) => void
  /** Starts the refresh and the poll, and refreshes now; nothing while they run. */
  start: () => void
  /** Stops them; the board opens again on its columns. */
  stop: () => void
  /** Makes the Priority writes that wait for the presses to stop now; resolves when every write ended. */
  flush: () => Promise<void>
  /** What the board posted. */
  handle: (message: BoardMessage) => void
}

export function createController(): Controller {
  // The defaults with `.claude/kanban.json` over them, read again at each refresh.
  let config: Config = DEFAULT_CONFIG
  // Where the file is looked for, first found wins: the session's worktree, the main one. Null until the first refresh.
  let roots: string[] | null = null
  // What was wrong with the file when last read, to say it again only when it changes.
  let configProblems = ''
  // The first of them, shown in the board's status bar.
  let configProblem: string | null = null
  let host: Host | null = null
  let cwd = ''
  let repo: string | null = null
  let snapshot: Snapshot | null = null
  // The board as last published: the column each card stands in.
  let lastBoard: Board | null = null
  let fetchedAt = 0
  let branches: string[] = []
  // The refresh from GitHub and the poll of the branches; null while the board is closed.
  let refreshTimer: Timer | null = null
  let pollTimer: Timer | null = null
  let isRefreshing = false
  // Grows with each issue the detail view asks for: a slower, older load is dropped.
  let detailTicket = 0
  // The owner's Priority field: undefined until read, null when the owner has none.
  let priorityField: PriorityField | null | undefined
  let priorityError: string | null = null
  const overrides = new Map<number, Override>()
  // The writes of each issue run one after another, so the last write wins.
  const writes = new Map<number, Promise<void>>()
  // The presses of each issue not yet written: the value and override before the first of them,
  // the write, and the timer that makes it after the last.
  const bursts = new Map<
    number,
    { base: Priority | null; before: Override | undefined; write: () => Promise<void>; timer: Timer }
  >()
  // Grows with each refresh that starts: what an override's `readAfter` counts in.
  let refreshes = 0
  // Whether this session runs inside Orca: it starts cards in an Orca tab, else in iTerm.
  let isOrca = false
  // The sessions the board started, read from the store at each refresh; null until the first.
  let records: Records | null = null
  // The last report of each of those sessions, by record id: read with the branches.
  let reports = new Map<string, Report>()
  // The session states the board last showed, to publish again only when one changes.
  let shownSessions = ''
  // Cards being started, focused or resumed: a second `s` before the tab opens does nothing.
  const starting = new Set<number>()
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
      configProblem,
    })
    await to.setBoard(lastBoard)
  }

  /**
   * `.claude/kanban.json` over the defaults (spec section 10): the file of the session's worktree,
   * else the main worktree's (a session Orca runs in a linked worktree finds the repository's).
   * The board skips a wrong part (its default stays) and names the first one in its status bar;
   * a toast says so when the problems change. A new `refreshSeconds` restarts the refresh timer.
   */
  const loadConfig = async (to: Host) => {
    roots ??= [...new Set([await worktreeRoot(to, cwd), await repoRoot(to, cwd)])]
    let text: string | null = null
    let problems: string[] = []
    try {
      for (const root of roots) {
        text = await to.readText(`${root}/${CONFIG_PATH}`)
        if (text !== null) break
      }
    } catch (error) {
      problems = [`could not be read (${messageOf(error)})`]
    }
    const read = configOf(text)
    problems.push(...read.problems)
    const seconds = config.refreshSeconds
    config = read.config
    configProblem = problems[0] ?? null
    if (config.refreshSeconds !== seconds && refreshTimer !== null) {
      refreshTimer.cancel()
      refreshTimer = to.every(config.refreshSeconds * 1000, () => void refresh(to))
    }
    const said = problems.join('\n')
    if (said === configProblems) return
    configProblems = said
    if (problems.length === 0) return
    for (const problem of problems) to.log(`kanban-board: ${CONFIG_PATH}: ${problem}`)
    const more = problems.length === 1 ? '' : ` (and ${problems.length - 1} more: see the debug log)`
    to.toast(`${CONFIG_PATH}: ${problems[0]}; the board skips it${more}`)
  }

  const refresh = async (to: Host) => {
    if (isRefreshing) return
    isRefreshing = true
    try {
      await to.setStatus({ isLoading: true, error: null })
      await loadConfig(to)
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
    const write = () => writeLater(to, number, mine, issueId, field)
    bursts.set(number, { base, before, write, timer: to.after(PRIORITY_DELAY_MS, () => void write()) })
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
    const inOrca = isOrca
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

  /** Records a session the board started for the issue, and shows its card in In progress. */
  const addRecord = async (to: Host, at: string, number: number, record: SessionRecord) => {
    let dropped: string[] = []
    await saveRecords(to, at, kept => {
      const added = withRecord(kept, number, record)
      dropped = added.dropped
      return added.records
    })
    // A record that fell off the end takes its report along.
    for (const id of dropped) await to.deleteStore(reportKey(id)).catch(() => undefined)
    // A session started here reported already.
    await readReports(to).catch(() => undefined)
    await publish(to)
  }

  /** A new session with the prompt its labels call for, in a new tab; the board records it. */
  const startSession = async (to: Host, at: string, number: number, title: string, prompt: string) => {
    const root = await repoRoot(to, cwd)
    const sessionId = crypto.randomUUID()
    const name = sessionName(number, title)
    const tab = await openTab(to, root, name, claudeCommand(sessionId, name, prompt))
    await addRecord(to, at, number, { sessionId, terminal: tab.terminal, startedAt: await to.now() })
    to.toast(`Started #${number} in a new ${tab.app} tab: ${prompt}`)
  }

  /**
   * The prompt in the session the board runs in, as the person's own. The
   * board records it under a new id, which the session reports under from then on.
   */
  const startHere = async (to: Host, here: Here, at: string, number: number, prompt: string) => {
    await here.submit(prompt)
    const recordId = crypto.randomUUID()
    await here.track(recordId)
    await addRecord(to, at, number, { sessionId: recordId, terminal: null, startedAt: await to.now() })
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
    const live = issueSession(number, await to.now())?.live ?? null
    if (live !== null && to.here?.isTracked(live.sessionId) === true) {
      to.toast(`#${number} runs in this session`)
      return
    }
    const terminal = live?.terminal ?? null
    if (terminal === null) throw new Error('the board does not know its tab')
    const run = await to.run(focusArgv(terminal), { cwd, timeoutMs: 30_000 })
    if (run.exitCode !== 0) {
      throw new Error(run.stderr.trim().split('\n')[0] || `${terminal.app === 'orca' ? 'orca' : 'osascript'} exited with ${run.exitCode}`)
    }
    if (terminal.app === 'iterm' && run.stdout.trim() === ITERM_MISSING) throw new Error('its iTerm tab is closed')
  }

  /**
   * `s` / `S` (spec section 7): a running session's tab comes forward; In
   * progress and Review resume the last session; the label columns start the
   * prompt their labels call for. `s` (`here`) submits it in the session the
   * board runs in; `S` (`new`), and `s` where there is none (the terminal
   * board), start a new session in the repository root, in a new Orca tab
   * inside Orca and a new iTerm tab elsewhere. The board writes nothing to
   * GitHub; it records the sessions it starts.
   */
  const startCard = async (to: Host, number: number, where: StartWhere) => {
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
      if (launch.kind === 'start') {
        if (where === 'here' && to.here !== undefined) await startHere(to, to.here, at, number, launch.prompt)
        else await startSession(to, at, number, card.title, launch.prompt)
      }
    } catch (error) {
      to.toast(`Could not ${launch.kind} #${number}: ${messageOf(error)}`)
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
    if (to === null || refreshTimer !== null) return
    refreshTimer = to.every(config.refreshSeconds * 1000, () => void refresh(to))
    pollTimer = to.every(LOCAL_POLL_MS, () => void pollLocal(to))
    void refresh(to)
  }

  const stop = () => {
    refreshTimer?.cancel()
    pollTimer?.cancel()
    refreshTimer = null
    pollTimer = null
    // The board opens again on its columns.
    if (host !== null) closeDetail(host)
  }

  const flush = async () => {
    await Promise.all(
      [...bursts.values()].map(burst => {
        burst.timer.cancel()
        return burst.write()
      }),
    )
    await Promise.all(writes.values())
  }

  return {
    attach: (to, at, inOrca) => {
      host = to
      cwd = at
      isOrca = inOrca
    },
    start,
    stop,
    flush,
    handle: message => {
      const to = host
      if (to === null) return
      if (message.type === 'refresh') void refresh(to)
      if (message.type === 'open') openInBrowser(to, message.number)
      if (message.type === 'detail') void showIssue(to, message.number)
      if (message.type === 'back') closeDetail(to)
      if (message.type === 'priority') void changePriority(to, message.number, message.action, message.current)
      if (message.type === 'start') void startCard(to, message.number, message.where ?? 'new')
    },
  }
}
