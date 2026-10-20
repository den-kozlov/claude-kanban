// The `Host` the board's background work runs through (hooks/lib/controller.ts),
// bound to Node instead of `$`: processes, timers, files, the mod's store,
// and the board's props kept in memory for the screen to draw.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { ProcessRunInit, ProcessRunResult, Timer } from 'claude-code'

import type { Board, BoardStatus, Detail, SelectRequest } from '../types'
import type { Host } from '../hooks/lib/controller'
import type { Store } from './store'

/** What the hooks module keeps in `$.state` for the pane: here, the screen's. */
export type BoardData = {
  board: Board | null
  status: BoardStatus
  pick: SelectRequest | null
  detail: Detail | null
}

/** The process `argv` runs, its output kept; a run past `timeoutMs` is killed. */
export function run(argv: readonly string[], init: ProcessRunInit = {}): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const [command = '', ...args] = argv
    const child = spawn(command, args, {
      cwd: init.cwd,
      env: { ...process.env, ...init.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let isTimedOut = false
    child.stdout?.setEncoding('utf8').on('data', chunk => (stdout += chunk))
    child.stderr?.setEncoding('utf8').on('data', chunk => (stderr += chunk))
    const timer =
      init.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            isTimedOut = true
            child.kill('SIGKILL')
          }, init.timeoutMs)
    child.on('error', error => {
      if (timer !== null) clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (timer !== null) clearTimeout(timer)
      const result = { stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }
      if (isTimedOut) resolve({ ...result, exitCode: 124, stderr: `${argv[0]} timed out after ${init.timeoutMs} ms` })
      else resolve({ ...result, exitCode: code ?? 1 })
    })
    child.stdin?.end(init.stdin)
  })
}

const timerOf = (cancel: () => void): Timer => ({ cancel })

export type ScreenPort = {
  data: BoardData
  /** The data changed: draw again. */
  changed: () => void
  toast: (text: string) => void
  log: (text: string) => void
}

export function nodeHost(store: Store, screen: ScreenPort): Host {
  const set = <K extends keyof BoardData>(key: K, value: BoardData[K]) => {
    screen.data[key] = value
    screen.changed()
    return Promise.resolve()
  }
  return {
    run,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Promise.resolve(Date.now()),
    every: (ms, fn) => {
      const id = setInterval(fn, ms)
      return timerOf(() => clearInterval(id))
    },
    after: (ms, fn) => {
      const id = setTimeout(fn, ms)
      return timerOf(() => clearTimeout(id))
    },
    setBoard: value => set('board', value),
    setStatus: value => set('status', value),
    setDetail: value => set('detail', value),
    updateDetail: fn => set('detail', fn(screen.data.detail)),
    readStore: key => store.get(key),
    writeStore: (key, value) => store.set(key, value),
    deleteStore: key => store.delete(key),
    pick: number => set('pick', { number, seq: (screen.data.pick?.seq ?? 0) + 1 }),
    toast: text => screen.toast(text),
    log: text => screen.log(text),
    readText: path =>
      readFile(path, 'utf8').catch((error: { code?: string }) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
        throw error
      }),
  }
}
