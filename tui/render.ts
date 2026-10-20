// The terminal board's drawing: the `Box` and `Text` elements the board's
// surface module (hooks/board.tsx) draws with, laid out in cells and painted
// as ANSI lines. Only what the module uses: rows and columns, fixed sizes,
// `flexGrow`, `columnGap`, `justifyContent: flex-end`, truncated or wrapped
// text and its colour. Pure: no Node, so the tests run it directly.

import { cellWidth, charWidth, truncate, wrap } from '../hooks/lib/text'

/** An element as `h` builds it: a tag, its props and its children with the empty ones left out. */
export type Node = { type: 'Box' | 'Text'; props: Record<string, unknown>; children: Child[] }
type Child = Node | string

type Props = Record<string, unknown> & { children?: unknown }

function childrenOf(value: unknown): Child[] {
  if (Array.isArray(value)) return value.flatMap(childrenOf)
  if (value === null || value === undefined || typeof value === 'boolean') return []
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  return [value as Node]
}

const element = (type: Node['type']) => (props: Props) => {
  const { children, ...rest } = props
  return { type, props: rest, children: childrenOf(children) }
}

export const Box = element('Box')
export const Text = element('Text')

/** `<>...</>`: a column Box around the children, as in the engine. */
export const Fragment = (props: Props) => Box({ ...props, flexDirection: 'column' })

/** The table a surface module takes its tags from; tags it does not use draw as a Box. */
export const elements: Record<string, (props: Props) => Node> = new Proxy(
  { Box, Text },
  { get: (table, name: string) => (table as Record<string, (props: Props) => Node>)[name] ?? Box },
)

/** The JSX factory the board's module compiles against: components are called at once. */
export function h(tag: unknown, props: Props | null, ...children: unknown[]): unknown {
  const all = { ...(props ?? {}), children: children.length === 1 ? children[0] : children }
  if (typeof tag === 'function') return (tag as (props: Props) => unknown)(all)
  return Box(all)
}

export type Style = { color: string | null; dim: boolean; bold: boolean; inverse: boolean }

const PLAIN: Style = { color: null, dim: false, bold: false, inverse: false }

/** One cell: its character, '' where a wide character to its left covers it. */
type Cell = { ch: string; style: Style }

export type Grid = { width: number; height: number; cells: Cell[][] }

export function gridOf(width: number, height: number): Grid {
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', style: PLAIN })))
  return { width, height, cells }
}

/** Writes `text` from (x, y) on, never past `right`; a wide character that does not fit is a space. */
export function put(grid: Grid, x: number, y: number, text: string, style: Style, right = grid.width) {
  const row = grid.cells[y]
  if (row === undefined) return
  const end = Math.min(right, grid.width)
  let at = x
  for (const ch of text) {
    const width = charWidth(ch.codePointAt(0) ?? 0)
    if (width === 0) {
      const before = row[at - 1]
      if (before !== undefined && at - 1 >= x) before.ch += ch
      continue
    }
    if (at + width > end) {
      if (at < end) row[at] = { ch: ' ', style }
      break
    }
    if (at >= 0) row[at] = { ch, style }
    if (width === 2 && at + 1 >= 0) row[at + 1] = { ch: '', style }
    at += width
  }
}

const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null)

const textOf = (node: Node): string =>
  node.children.map(child => (typeof child === 'string' ? child : textOf(child))).join('')

const isTruncated = (node: Node) => typeof node.props.wrap === 'string' && node.props.wrap.startsWith('truncate')

/** The lines of a Text `width` cells wide: one cut line, or the text wrapped at words. */
function textLines(node: Node, width: number): string[] {
  const text = textOf(node)
  if (isTruncated(node)) return [truncate(text.split('\n')[0] ?? '', width)]
  // A line that fits keeps its spaces (the selection mark is `▌ `); a longer one wraps at words.
  return text
    .split('\n')
    .flatMap(line => (cellWidth(line) <= width ? [line] : wrap(line, width, Number.MAX_SAFE_INTEGER)))
}

const isRow = (node: Node) => node.props.flexDirection !== 'column' && node.props.flexDirection !== 'column-reverse'
const gapOf = (node: Node, key: 'columnGap' | 'rowGap') => numberOf(node.props[key]) ?? numberOf(node.props.gap) ?? 0

/** The size a node takes when nothing stretches it, at most `width` cells wide. */
export function measure(node: Child, width: number): { width: number; height: number } {
  if (typeof node === 'string') return { width: Math.min(cellWidth(node), width), height: 1 }
  if (node.type === 'Text') {
    const lines = textLines(node, width)
    return { width: Math.max(0, ...lines.map(cellWidth)), height: lines.length }
  }
  const fixedWidth = numberOf(node.props.width)
  const fixedHeight = numberOf(node.props.height)
  const room = Math.min(fixedWidth ?? width, width)
  let w = 0
  let h = 0
  if (isRow(node)) {
    const gap = gapOf(node, 'columnGap')
    for (const [index, child] of node.children.entries()) {
      const size = measure(child, Math.max(0, room - w))
      w += size.width + (index > 0 ? gap : 0)
      h = Math.max(h, size.height)
    }
  } else {
    const gap = gapOf(node, 'rowGap')
    for (const [index, child] of node.children.entries()) {
      const size = measure(child, room)
      w = Math.max(w, size.width)
      h += size.height + (index > 0 ? gap : 0)
    }
  }
  return { width: Math.min(fixedWidth ?? w, width), height: fixedHeight ?? h }
}

function styleOf(node: Node, inherited: Style): Style {
  const { color, dimColor, bold, inverse } = node.props
  return {
    color: typeof color === 'string' ? color : inherited.color,
    dim: dimColor === true || inherited.dim,
    bold: bold === true || inherited.bold,
    inverse: inverse === true || inherited.inverse,
  }
}

/** Paints `node` in the rectangle at (x, y), `width` × `height` cells; nothing leaves it. */
export function paint(grid: Grid, node: Child, x: number, y: number, width: number, height: number, style = PLAIN) {
  if (width <= 0 || height <= 0) return
  if (typeof node === 'string') {
    put(grid, x, y, node, style, x + width)
    return
  }
  if (node.type === 'Text') {
    const own = styleOf(node, style)
    textLines(node, width)
      .slice(0, height)
      .forEach((line, index) => put(grid, x, y + index, line, own, x + width))
    return
  }
  const w = Math.min(numberOf(node.props.width) ?? width, width)
  const h = Math.min(numberOf(node.props.height) ?? height, height)
  if (isRow(node)) paintRow(grid, node, x, y, w, h, style)
  else paintColumn(grid, node, x, y, w, h, style)
}

function paintRow(grid: Grid, node: Node, x: number, y: number, width: number, height: number, style: Style) {
  const gap = gapOf(node, 'columnGap')
  const growOf = (child: Child) => (typeof child === 'string' ? 0 : (numberOf(child.props.flexGrow) ?? 0))
  // The children that do not grow first, each in what is left; the growing ones share the rest.
  const widths = new Map<number, number>()
  let used = Math.max(0, node.children.length - 1) * gap
  node.children.forEach((child, index) => {
    if (growOf(child) > 0) return
    const fixed = typeof child === 'string' ? null : numberOf(child.props.width)
    const w = Math.min(fixed ?? measure(child, Math.max(0, width - used)).width, Math.max(0, width - used))
    widths.set(index, w)
    used += w
  })
  const grow = node.children.reduce((sum, child) => sum + growOf(child), 0)
  let spare = Math.max(0, width - used)
  node.children.forEach((child, index) => {
    if (growOf(child) === 0) return
    const w = Math.floor((spare * growOf(child)) / grow)
    widths.set(index, w)
    used += w
  })
  spare = Math.max(0, width - used)
  let at = x + (grow === 0 && node.props.justifyContent === 'flex-end' ? spare : 0)
  node.children.forEach((child, index) => {
    const w = widths.get(index) ?? 0
    const fixed = typeof child === 'string' ? null : numberOf(child.props.height)
    paint(grid, child, at, y, Math.min(w, x + width - at), Math.min(fixed ?? height, height), style)
    at += w + gap
  })
}

function paintColumn(grid: Grid, node: Node, x: number, y: number, width: number, height: number, style: Style) {
  const gap = gapOf(node, 'rowGap')
  let at = y
  for (const child of node.children) {
    if (at >= y + height) break
    const fixedWidth = typeof child === 'string' ? null : numberOf(child.props.width)
    const w = Math.min(fixedWidth ?? width, width)
    const h = Math.min(measure(child, w).height, y + height - at)
    paint(grid, child, x, at, w, h, style)
    at += h + gap
  }
}

/** The colour names the engine's theme gives, as SGR codes. */
const COLORS: Record<string, string> = {
  success: '32',
  error: '31',
  warning: '33',
  claude: '38;5;173',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  gray: '90',
  grey: '90',
}

function sgr(style: Style): string {
  const codes = ['0']
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.inverse) codes.push('7')
  const color = style.color === null ? undefined : COLORS[style.color]
  if (color !== undefined) codes.push(color)
  return `\x1b[${codes.join(';')}m`
}

const sameStyle = (a: Style, b: Style) =>
  a.color === b.color && a.dim === b.dim && a.bold === b.bold && a.inverse === b.inverse

/** Each row of the grid as one ANSI line, its style reset at the end. */
export function linesOf(grid: Grid): string[] {
  return grid.cells.map(row => {
    let out = ''
    let current = PLAIN
    for (const cell of row) {
      if (cell.ch === '') continue
      if (!sameStyle(cell.style, current)) {
        out += sgr(cell.style)
        current = cell.style
      }
      out += cell.ch
    }
    return sameStyle(current, PLAIN) ? out : `${out}\x1b[0m`
  })
}

/** Each row of the grid as plain text: what the tests read. */
export function textOfGrid(grid: Grid): string[] {
  return grid.cells.map(row => row.map(cell => cell.ch).join('').trimEnd())
}
