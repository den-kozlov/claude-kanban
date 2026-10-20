import { describe, expect, test } from 'claude-code/testing'

import {
  claudeCommand,
  focusArgv,
  itermIdOf,
  launchOf,
  orcaHandleOf,
  resumeCommand,
  sessionName,
  shellQuote,
  slashOf,
} from '../hooks/lib/launch'
import { DEFAULT_CONFIG } from '../hooks/lib/model'
import type { SessionState } from '../types'

const launch = (
  column: Parameters<typeof launchOf>[1],
  labels: string[],
  parentLabels: string[] = [],
  session: SessionState | null = null,
) => launchOf(7, column, labels, parentLabels, DEFAULT_CONFIG, session)

const start = (prompt: string) => ({ kind: 'start', prompt })
const none = (reason: string) => ({ kind: 'none', reason })

describe('launch', () => {
  test('the first matching rule gives the prompt', async () => {
    expect(launch('triage', ['needs-triage', 'wayfinder:research'])).toEqual(start('/triage #7'))
    expect(launch('readyForHuman', ['ready-for-human', 'wayfinder:research'])).toEqual(start('/wayfinder #7'))
    expect(launch('readyForHuman', ['ready-for-human'], ['wayfinder:map'])).toEqual(start('/wayfinder #7'))
    expect(launch('readyForHuman', ['ready-for-human'])).toEqual(start('Start implementing issue #7'))
  })

  test('a Triage card with no label gets /triage', async () => {
    expect(launch('triage', [])).toEqual(start('/triage #7'))
  })

  test('the other columns do not start, and say why', async () => {
    expect(launch('blocked', ['ready-for-human'])).toEqual(none('Blocked: an open issue blocks it'))
    expect(launch('readyForAgent', ['ready-for-agent'])).toEqual(none('Ready for agent: Sandcastle takes it'))
    expect(launch('inProgress', ['ready-for-human'])).toEqual(none('In progress: the board started no session for it'))
    expect(launch('done', [], [], 'ended')).toEqual(none('Done: the issue is closed'))
  })

  test('a running session is focused; In progress and Review resume an ended one', async () => {
    expect(launch('inProgress', [], [], 'working')).toEqual({ kind: 'focus' })
    expect(launch('review', [], [], 'starting')).toEqual({ kind: 'focus' })
    expect(launch('inProgress', [], [], 'ended')).toEqual({ kind: 'resume' })
    expect(launch('review', [], [], 'ended')).toEqual({ kind: 'resume' })
    // After /triage the card stands in a label column again: s starts its next step.
    expect(launch('readyForHuman', ['ready-for-human'], [], 'ended')).toEqual(start('Start implementing issue #7'))
  })

  test('the command quotes the name and the prompt for the shell', async () => {
    const name = sessionName(7, "Don't\nbreak   the shell")

    expect(name).toBe("#7 Don't break the shell")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(claudeCommand('id-1', name, '/triage #7')).toBe(
      `KANBAN_BOARD_SESSION=id-1 claude --session-id id-1 --name '#7 Don'\\''t break the shell' '/triage #7'`,
    )
    expect(resumeCommand('id-1', 'id-2')).toBe('KANBAN_BOARD_SESSION=id-1 claude --resume id-2')
  })

  test('a tab comes forward by Orca handle or iTerm session id', async () => {
    expect(focusArgv({ app: 'orca', id: 'term_1' })).toEqual(['orca', 'terminal', 'switch', '--terminal', 'term_1'])
    const iterm = focusArgv({ app: 'iterm', id: 'ABC-1' })
    expect(iterm[0]).toBe('osascript')
    expect(iterm.at(-1)).toBe('ABC-1')
    expect(itermIdOf('ABC-1\n')).toBe('ABC-1')
    expect(itermIdOf('')).toBeNull()
  })

  test("Orca's handle is read wherever its answer nests it", async () => {
    expect(orcaHandleOf('{"ok":true,"result":{"terminal":{"handle": "term_1"}}}')).toBe('term_1')
    expect(orcaHandleOf('{}')).toBeNull()
  })
})

test('a prompt that starts with a slash is a command and its arguments; any other is a prompt', async () => {
  expect(slashOf('/triage #3')).toEqual({ command: 'triage', args: '#3' })
  expect(slashOf('/wayfinder')).toEqual({ command: 'wayfinder', args: '' })
  expect(slashOf('Start implementing issue #3')).toBeNull()
})
