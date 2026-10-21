// Starting a card (spec section 7): which prompt its labels call for, focus
// or resume where it has a session, or why it does nothing; and the commands
// that open a Claude session in an Orca or iTerm tab or bring its tab forward.
// Pure: no `$`, so the tests run it directly.

import type { ColumnId, SessionState } from '../../types'
import type { Config } from './model'
import { SESSION_ENV, type Terminal } from './sessions'
import { oneLine, truncate } from './text'

/**
 * One rule of `launch`: it matches an issue with the label, a label that
 * starts with `labelPrefix`, or a parent with `parentLabel`. `{n}` in the
 * prompt is the issue's number (`#{n}`: `#7`), `{title}` its title on one line.
 */
export type LaunchRule = { label?: string; labelPrefix?: string; parentLabel?: string; prompt: string }

/** What `s` does: start with a prompt, focus the running session's tab, resume the last session, or nothing. */
export type Launch =
  | { kind: 'start'; prompt: string }
  | { kind: 'focus' }
  | { kind: 'resume' }
  | { kind: 'none'; reason: string }

/** Why a card of the column does not start; the columns that start are not here. */
const NO_START: Partial<Record<ColumnId, string>> = {
  blocked: 'Blocked: an open issue blocks it',
  needsInfo: 'Needs info: it waits for an answer',
  readyForAgent: 'Ready for agent: Sandcastle takes it',
  done: 'Done: the issue is closed',
  inProgress: 'In progress: the board started no session for it',
  review: 'Review: the board started no session for it',
}

/** The columns where `s` resumes the last session rather than start a new one. */
const RESUMES: readonly ColumnId[] = ['inProgress', 'review']

const matches = (rule: LaunchRule, labels: string[], parentLabels: string[]) =>
  (rule.label !== undefined && labels.includes(rule.label)) ||
  (rule.labelPrefix !== undefined && labels.some(label => label.startsWith(rule.labelPrefix as string))) ||
  (rule.parentLabel !== undefined && parentLabels.includes(rule.parentLabel))

/**
 * What `s` does for a card (spec section 7). A running session is focused in
 * any column. In progress and Review resume the last session; the label
 * columns start a new one with the prompt of the first matching rule. A Triage
 * card with no rule of its own (an issue with no label) gets the rule of the
 * triage label.
 */
export function launchOf(
  number: number,
  title: string,
  column: ColumnId,
  labels: string[],
  parentLabels: string[],
  config: Config,
  session: SessionState | null = null,
): Launch {
  if (session !== null && session !== 'ended') return { kind: 'focus' }
  if (session === 'ended' && RESUMES.includes(column)) return { kind: 'resume' }
  const reason = NO_START[column]
  if (reason !== undefined) return { kind: 'none', reason }
  const rule =
    config.launch.find(one => matches(one, labels, parentLabels)) ??
    (column === 'triage' ? config.launch.find(one => one.label !== undefined && config.columns.triage.includes(one.label)) : undefined)
  if (rule === undefined) return { kind: 'none', reason: 'No launch rule matches its labels' }
  return { kind: 'start', prompt: promptOf(rule.prompt, number, title) }
}

/** A rule's prompt for the issue: `{n}` its number, `{title}` its title on one line. */
export function promptOf(template: string, number: number, title: string): string {
  return template.replaceAll('{n}', `${number}`).replaceAll('{title}', oneLine(title))
}

/**
 * The slash command a prompt runs (`/triage #3`: `triage`, `#3`); null for a
 * prompt to the model. A mod runs a command with `$.command.run`, never as a prompt.
 */
export function slashOf(prompt: string): { command: string; args: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(prompt.trim())
  return match === null ? null : { command: match[1] as string, args: (match[2] as string).trim() }
}

/** `text` as one word for a POSIX shell: in single quotes, each `'` closed, escaped and reopened. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** The new session's name: `#N title`, one line, cut to 60 cells. */
export function sessionName(number: number, title: string): string {
  return truncate(`#${number} ${oneLine(title)}`, 60)
}

/** The command line a new tab's shell runs: a new session, with the record id it reports under. */
export function claudeCommand(sessionId: string, name: string, prompt: string): string {
  return `${SESSION_ENV}=${sessionId} claude --session-id ${sessionId} --name ${shellQuote(name)} ${shellQuote(prompt)}`
}

/** The command line that resumes the session `sessionId`, still reporting under `recordId`. */
export function resumeCommand(recordId: string, sessionId: string): string {
  return `${SESSION_ENV}=${recordId} claude --resume ${sessionId}`
}

/**
 * Whether the board runs inside Orca: `TERM_PROGRAM` is `Orca`, or it is unset
 * and Orca's own `ORCA_TERMINAL_HANDLE` is set. A Claude session the daemon
 * runs (a spare `claude` claims, a background session) keeps Orca's variables
 * but has no `TERM_PROGRAM`.
 */
export function isInOrca(termProgram: string | undefined, orcaTerminal: string | undefined): boolean {
  if (termProgram !== undefined) return termProgram === 'Orca'
  return orcaTerminal !== undefined && orcaTerminal !== ''
}

/** `orca terminal create`: a visible, focused tab in the repository root's worktree. */
export function orcaArgv(root: string, name: string, command: string): string[] {
  return ['orca', 'terminal', 'create', '--worktree', `path:${root}`, '--title', name, '--command', command, '--focus', '--json']
}

/** The terminal handle in `orca terminal create --json`'s answer, wherever it nests it. */
export function orcaHandleOf(stdout: string): string | null {
  return /"handle"\s*:\s*"([^"]+)"/.exec(stdout)?.[1] ?? null
}

/** `orca terminal switch`: brings the tab of `handle` forward. */
export function orcaFocusArgv(handle: string): string[] {
  return ['orca', 'terminal', 'switch', '--terminal', handle]
}

// The command crosses as an argument, never inside the script's own text. The
// answer is the new session's id, which the focus script looks for.
const ITERM_SCRIPT = `on run argv
  tell application "iTerm"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window
      write text (item 1 of argv)
      return id
    end tell
  end tell
end run`

/** A new iTerm tab (a new window when none is open) that runs `command` in `root`. */
export function itermArgv(root: string, command: string): string[] {
  return ['osascript', '-e', ITERM_SCRIPT, `cd ${shellQuote(root)} && ${command}`]
}

/** The iTerm session id the new-tab script answers; null when it answers none. */
export function itermIdOf(stdout: string): string | null {
  const id = stdout.trim()
  return id === '' ? null : id
}

/** The focus script's answer when no iTerm session has the id. */
export const ITERM_MISSING = 'missing'

const ITERM_FOCUS_SCRIPT = `on run argv
  tell application "iTerm"
    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        repeat with aSession in sessions of aTab
          if id of aSession is (item 1 of argv) then
            select aWindow
            select aTab
            select aSession
            activate
            return "found"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "${ITERM_MISSING}"
end run`

/** Brings the iTerm tab of the session `id` forward; it answers `missing` when that tab is closed. */
export function itermFocusArgv(id: string): string[] {
  return ['osascript', '-e', ITERM_FOCUS_SCRIPT, id]
}

/** The command that brings the session's tab forward. */
export function focusArgv(terminal: Terminal): string[] {
  return terminal.app === 'orca' ? orcaFocusArgv(terminal.id) : itermFocusArgv(terminal.id)
}
