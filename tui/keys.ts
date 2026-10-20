// What the terminal sends on stdin in raw mode, as the key and pointer events
// a `Client` takes: special keys by name, characters as typed, and the SGR
// mouse reports (`ESC [ < b ; x ; y M`). Pure: the tests feed it strings.

import type { ClientKeyEvent, ClientPointerEvent } from 'claude-code'

export type Input =
  | { kind: 'key'; event: ClientKeyEvent }
  | { kind: 'pointer'; event: ClientPointerEvent }
  /** The mouse wheel: -1 up, 1 down. */
  | { kind: 'wheel'; step: -1 | 1 }

const ESC = '\x1b'

/** CSI and SS3 sequences by their final part, the parameters before it left out. */
const NAMED: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  '1~': 'home',
  '7~': 'home',
  '4~': 'end',
  '8~': 'end',
  '2~': 'insert',
  '3~': 'delete',
  '5~': 'pageup',
  '6~': 'pagedown',
}

const key = (name: string, mods: Omit<ClientKeyEvent, 'key'> = {}): Input => ({ kind: 'key', event: { key: name, ...mods } })

/** The modifiers of an xterm parameter (`1;2A`: shift): 1 + shift 1, alt 2, ctrl 4. */
function modsOf(param: string | undefined): Omit<ClientKeyEvent, 'key'> {
  const bits = Number(param ?? '1') - 1
  if (!Number.isInteger(bits) || bits <= 0) return {}
  return {
    ...((bits & 1) !== 0 ? { shift: true as const } : {}),
    ...((bits & 2) !== 0 ? { meta: true as const } : {}),
    ...((bits & 4) !== 0 ? { ctrl: true as const } : {}),
  }
}

function mouseOf(code: number, x: number, y: number, isRelease: boolean): Input | null {
  if ((code & 64) !== 0) return (code & 1) === 0 ? { kind: 'wheel', step: -1 } : { kind: 'wheel', step: 1 }
  const button = (['left', 'middle', 'right'] as const)[code & 3]
  const isMove = (code & 32) !== 0
  const type = isRelease ? 'up' : isMove ? 'move' : 'down'
  const event: ClientPointerEvent = {
    type,
    x: x - 1,
    y: y - 1,
    ...(button === undefined ? {} : { button }),
    ...((code & 4) !== 0 ? { shift: true as const } : {}),
    ...((code & 8) !== 0 ? { alt: true as const } : {}),
    ...((code & 16) !== 0 ? { ctrl: true as const } : {}),
  }
  return { kind: 'pointer', event }
}

/** One escape sequence at the start of `text`: what it means (null: nothing) and its length. */
function sequence(text: string): { input: Input | null; length: number } {
  // A lone ESC: the Escape key.
  if (text.length === 1) return { input: key('escape'), length: 1 }
  const second = text[1] as string
  if (second === '[' || second === 'O') {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text)
    if (mouse !== null) {
      const [all, code, x, y, end] = mouse as unknown as [string, string, string, string, string]
      return { input: mouseOf(Number(code), Number(x), Number(y), end === 'm'), length: all.length }
    }
    // Parameters, then one final byte.
    const csi = /^\x1b[[O]([0-9;]*)([\x40-\x7e])/.exec(text)
    if (csi === null) return { input: key('escape'), length: 1 }
    const [all, params = '', final = ''] = csi as unknown as [string, string, string]
    if (final === 'Z') return { input: key('tab', { shift: true }), length: all.length }
    const parts = params.split(';')
    const name = final === '~' ? NAMED[`${parts[0] ?? ''}~`] : NAMED[final]
    if (name === undefined) return { input: null, length: all.length }
    return { input: key(name, modsOf(parts[1])), length: all.length }
  }
  // Alt with a key: ESC, then the key.
  const ch = Array.from(text.slice(1))[0] ?? ''
  const inner = parse(ch)[0]
  if (inner?.kind === 'key') return { input: { kind: 'key', event: { ...inner.event, meta: true } }, length: 1 + ch.length }
  return { input: key('escape'), length: 1 }
}

/** The events in one read of stdin, in order. */
export function parse(text: string): Input[] {
  const inputs: Input[] = []
  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    if (rest.startsWith(ESC)) {
      const { input, length } = sequence(rest)
      if (input !== null) inputs.push(input)
      at += length
      continue
    }
    const ch = Array.from(rest)[0] as string
    at += ch.length
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\r' || ch === '\n') inputs.push(key('return'))
    else if (ch === '\t') inputs.push(key('tab'))
    else if (ch === '\x7f' || ch === '\b') inputs.push(key('backspace'))
    else if (code < 0x20) inputs.push(key(String.fromCharCode(code + 0x60), { ctrl: true }))
    else inputs.push(key(ch))
  }
  return inputs
}
