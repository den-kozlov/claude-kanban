import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 20, 12)

/** Starts a session with `env`; returns the plugin's store, in memory. */
async function startSession($: Engine, on: On, env: Record<string, string>, isInteractive = true) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.panes', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive })
  await clock.settle()
  return { clock, stored }
}

test('a session the board started reports its state under its record id', async ($, on) => {
  const { clock, stored } = await startSession($, on, { KANBAN_BOARD_SESSION: 'rec-1' })
  const state = () => (stored.get('live:rec-1') as { state: string } | undefined)?.state

  expect(stored.get('live:rec-1')).toEqual({ state: 'waiting', at: NOW, sessionId: 'session-1' })

  await $.turn.start({ text: '/triage #3', turnId: 't1' })
  await clock.settle()
  expect(state()).toBe('working')

  // A permission prompt waits for the person; the tool's end means they answered.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'gh issue edit 3' } })
  await clock.settle()
  expect(state()).toBe('waiting')
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1' })
  await clock.settle()
  expect(state()).toBe('working')

  // A subagent's turn is not the session's.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer' })
  await clock.settle()
  expect(state()).toBe('working')

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(state()).toBe('waiting')

  // The heartbeat keeps the report fresh.
  await clock.advance(10_000)
  expect(stored.get('live:rec-1')).toEqual({ state: 'waiting', at: NOW + 10_000, sessionId: 'session-1' })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
  expect(state()).toBe('ended')
})

test('a /clear does not end the report', async ($, on) => {
  const { clock, stored } = await startSession($, on, { KANBAN_BOARD_SESSION: 'rec-1' })
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  await clock.settle()

  expect((stored.get('live:rec-1') as { state: string }).state).toBe('waiting')
})

test('a session the board did not start reports nothing', async ($, on) => {
  const { stored } = await startSession($, on, {})
  await $.turn.start({ text: 'hello', turnId: 't1' })

  expect([...stored.keys()]).toEqual([])
})

test('a -p run of a started session reports nothing', async ($, on) => {
  const { stored } = await startSession($, on, { KANBAN_BOARD_SESSION: 'rec-1' }, false)

  expect([...stored.keys()]).toEqual([])
})
