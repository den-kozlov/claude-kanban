// The few Node APIs the terminal board uses (Bun has them too), declared
// here so the type-check needs no package: `npx -p typescript tsc -p tui`.

declare function setTimeout(fn: () => void, ms: number): unknown
declare function clearTimeout(id: unknown): void
declare function setInterval(fn: () => void, ms: number): unknown
declare function clearInterval(id: unknown): void

type NodeListener = (...args: any[]) => void

interface NodeReadable {
  on(event: 'data', fn: (chunk: string) => void): this
  on(event: string, fn: NodeListener): this
  setEncoding(encoding: 'utf8'): this
}

declare const process: {
  argv: string[]
  env: Record<string, string | undefined>
  pid: number
  exitCode: number | undefined
  cwd(): string
  exit(code?: number): never
  on(event: string, fn: NodeListener): void
  stdin: NodeReadable & { isTTY?: boolean; setRawMode(mode: boolean): void; resume(): void; pause(): void }
  stdout: { isTTY?: boolean; columns: number; rows: number; write(text: string): boolean; on(event: 'resize', fn: () => void): void }
  stderr: { write(text: string): boolean }
}

declare module 'node:child_process' {
  type ChildProcess = {
    stdout: NodeReadable | null
    stderr: NodeReadable | null
    stdin: { end(data?: string): void } | null
    on(event: 'error', fn: (error: Error) => void): ChildProcess
    on(event: 'close', fn: (code: number | null) => void): ChildProcess
    kill(signal?: string): boolean
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; stdio?: ('pipe' | 'ignore')[] },
  ): ChildProcess
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>
  export function rename(from: string, to: string): Promise<void>
  export function readdir(path: string): Promise<string[]>
  export function stat(path: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}
