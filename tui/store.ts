// The mod's `$.store`, read and written from outside Claude Code: one JSON
// file per installed plugin under `<config dir>/plugins/store/`, named
// `kanban-board_<marketplace>-<hash>.json`. The board in a session writes the
// records of the sessions it starts there, and each started session its
// report: the terminal board reads and writes the same file, so both boards
// see the same sessions. Each set reads the file again and replaces it whole
// with a rename, so a reader never sees half a file.

import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Store = {
  /** The file; it need not exist yet. */
  path: string
  /** False when no session wrote the mod's store yet: started sessions report to a file the board does not read. */
  isShared: boolean
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
}

/** The terminal board's own store, while no session has written the mod's. */
const OWN = 'kanban-board_tui.json'

/** Claude Code's configuration folder, as Claude Code finds it. */
export function configDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/**
 * The mod's store file: `KANBAN_BOARD_STORE` when set, else the newest
 * `kanban-board_*.json` (the mod installed from two marketplaces has two),
 * else a file of the terminal board's own.
 */
export async function findStore(env: Record<string, string | undefined>): Promise<{ path: string; isShared: boolean }> {
  const given = env.KANBAN_BOARD_STORE
  if (given !== undefined && given !== '') return { path: given, isShared: true }
  const dir = join(configDir(env), 'plugins', 'store')
  const names = await readdir(dir).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter(name => /^kanban-board_.+\.json$/.test(name) && name !== OWN)
      .map(async name => ({ path: join(dir, name), at: (await stat(join(dir, name))).mtimeMs })),
  )
  const newest = found.sort((a, b) => b.at - a.at)[0]
  return newest === undefined ? { path: join(dir, OWN), isShared: false } : { path: newest.path, isShared: true }
}

type Data = Record<string, unknown>

export function storeAt(path: string, isShared: boolean, pid: number): Store {
  const load = async (): Promise<Data> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return {}
    }
    const data: unknown = JSON.parse(text)
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Data) : {}
  }
  // One change after another: each reads what the last one wrote.
  let queue: Promise<unknown> = Promise.resolve()
  const change = (fn: (data: Data) => void) => {
    const next = queue.then(async () => {
      const data = await load()
      fn(data)
      const temp = `${path}.${pid}.tmp`
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
    })
    queue = next.catch(() => undefined)
    return next
  }
  return {
    path,
    isShared,
    get: async key => (await load())[key],
    set: (key, value) =>
      change(data => {
        data[key] = JSON.parse(JSON.stringify(value)) as unknown
      }),
    delete: key =>
      change(data => {
        delete data[key]
      }),
  }
}
