import { describe, expect, test } from 'claude-code/testing'

import { claudeCommand, launchOf, orcaHandleOf, sessionName, shellQuote } from '../hooks/lib/launch'
import { DEFAULT_CONFIG } from '../hooks/lib/model'

const launch = (column: Parameters<typeof launchOf>[1], labels: string[], parentLabels: string[] = []) =>
  launchOf(7, column, labels, parentLabels, DEFAULT_CONFIG)

describe('launch', () => {
  test('the first matching rule gives the prompt', async () => {
    expect(launch('triage', ['needs-triage', 'wayfinder:research'])).toEqual({ prompt: '/triage #7' })
    expect(launch('readyForHuman', ['ready-for-human', 'wayfinder:research'])).toEqual({ prompt: '/wayfinder #7' })
    expect(launch('readyForHuman', ['ready-for-human'], ['wayfinder:map'])).toEqual({ prompt: '/wayfinder #7' })
    expect(launch('readyForHuman', ['ready-for-human'])).toEqual({ prompt: 'Start implementing issue #7' })
  })

  test('a Triage card with no label gets /triage', async () => {
    expect(launch('triage', [])).toEqual({ prompt: '/triage #7' })
  })

  test('the other columns do not start, and say why', async () => {
    expect(launch('blocked', ['ready-for-human'])).toEqual({ reason: 'Blocked: an open issue blocks it' })
    expect(launch('readyForAgent', ['ready-for-agent'])).toEqual({ reason: 'Ready for agent: Sandcastle takes it' })
    expect(launch('inProgress', ['ready-for-human'])).toEqual({ reason: 'In progress: it has its session already' })
    expect(launch('done', [])).toEqual({ reason: 'Done: the issue is closed' })
  })

  test('the command quotes the name and the prompt for the shell', async () => {
    const name = sessionName(7, "Don't\nbreak   the shell")

    expect(name).toBe("#7 Don't break the shell")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(claudeCommand('id-1', name, '/triage #7')).toBe(`claude --session-id id-1 --name '#7 Don'\\''t break the shell' '/triage #7'`)
  })

  test("Orca's handle is read wherever its answer nests it", async () => {
    expect(orcaHandleOf('{"ok":true,"result":{"terminal":{"handle": "term_1"}}}')).toBe('term_1')
    expect(orcaHandleOf('{}')).toBeNull()
  })
})
