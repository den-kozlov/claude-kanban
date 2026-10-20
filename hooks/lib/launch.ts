// Starting a card (spec section 7): which prompt its labels call for, or why
// it does not start, and the commands that open the new Claude session in an
// Orca or iTerm tab. Pure: no `$`, so the tests run it directly.

import type { ColumnId } from '../../types'
import type { Config } from './model'
import { oneLine, truncate } from './text'

/**
 * One rule of `launch`: it matches an issue with the label, a label that
 * starts with `labelPrefix`, or a parent with `parentLabel`. `#{n}` in the
 * prompt is the issue's number.
 */
export type LaunchRule = { label?: string; labelPrefix?: string; parentLabel?: string; prompt: string }

export type Launch = { prompt: string } | { reason: string }

/** Why a card of the column does not start; the columns that start are not here. */
const NO_START: Partial<Record<ColumnId, string>> = {
  blocked: 'Blocked: an open issue blocks it',
  needsInfo: 'Needs info: it waits for an answer',
  readyForAgent: 'Ready for agent: Sandcastle takes it',
  done: 'Done: the issue is closed',
  // Focusing a live session and resuming the last one come with session tracking (stage 5).
  inProgress: 'In progress: it has its session already',
  review: 'Review: it has its session already',
}

const matches = (rule: LaunchRule, labels: string[], parentLabels: string[]) =>
  (rule.label !== undefined && labels.includes(rule.label)) ||
  (rule.labelPrefix !== undefined && labels.some(label => label.startsWith(rule.labelPrefix as string))) ||
  (rule.parentLabel !== undefined && parentLabels.includes(rule.parentLabel))

/**
 * The prompt the first matching rule gives, or why the card does not start.
 * A Triage card with no rule of its own (an issue with no label) gets the
 * rule of the triage label.
 */
export function launchOf(
  number: number,
  column: ColumnId,
  labels: string[],
  parentLabels: string[],
  config: Config,
): Launch {
  const reason = NO_START[column]
  if (reason !== undefined) return { reason }
  const rule =
    config.launch.find(one => matches(one, labels, parentLabels)) ??
    (column === 'triage' ? config.launch.find(one => one.label !== undefined && config.columns.triage.includes(one.label)) : undefined)
  if (rule === undefined) return { reason: 'No launch rule matches its labels' }
  return { prompt: rule.prompt.replaceAll('#{n}', `#${number}`) }
}

/** `text` as one word for a POSIX shell: in single quotes, each `'` closed, escaped and reopened. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** The new session's name: `#N title`, one line, cut to 60 cells. */
export function sessionName(number: number, title: string): string {
  return truncate(`#${number} ${oneLine(title)}`, 60)
}

/** The command line the new tab's shell runs. */
export function claudeCommand(sessionId: string, name: string, prompt: string): string {
  return `claude --session-id ${sessionId} --name ${shellQuote(name)} ${shellQuote(prompt)}`
}

/** `orca terminal create`: a visible, focused tab in the repository root's worktree. */
export function orcaArgv(root: string, name: string, command: string): string[] {
  return ['orca', 'terminal', 'create', '--worktree', `path:${root}`, '--title', name, '--command', command, '--focus', '--json']
}

/** The terminal handle in `orca terminal create --json`'s answer, wherever it nests it. */
export function orcaHandleOf(stdout: string): string | null {
  return /"handle"\s*:\s*"([^"]+)"/.exec(stdout)?.[1] ?? null
}

// The command crosses as an argument, never inside the script's own text.
const ITERM_SCRIPT = `on run argv
  tell application "iTerm"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window to write text (item 1 of argv)
  end tell
end run`

/** A new iTerm tab (a new window when none is open) that runs `command` in `root`. */
export function itermArgv(root: string, command: string): string[] {
  return ['osascript', '-e', ITERM_SCRIPT, `cd ${shellQuote(root)} && ${command}`]
}
