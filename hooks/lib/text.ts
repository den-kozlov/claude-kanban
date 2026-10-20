// Terminal cell widths, truncation and word wrap. The board computes every
// row itself, so what it lays out is what the terminal draws.

const ZERO_WIDTH: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xe0100, 0xe01ef],
]

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([from, to]) => cp >= from && cp <= to)

export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (inRanges(cp, ZERO_WIDTH)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

export function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0)
  return width
}

/** One line of plain text: control characters and runs of spaces become one space. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
}

/** Cuts `text` to `width` cells, ending in `…` when cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…'
}

/** Splits `text` after as many characters as fit in `width` cells (one at least). */
function takeCells(text: string, width: number): [string, string] {
  let head = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (head !== '' && used + w > width) break
    head += ch
    used += w
  }
  return [head, text.slice(head.length)]
}

/** Pads `text` with spaces to `width` cells (cutting it first when longer). */
export function pad(text: string, width: number): string {
  const cut = truncate(text, width)
  return cut + ' '.repeat(Math.max(0, width - cellWidth(cut)))
}

/**
 * Wraps `text` at word boundaries into at most `maxLines` lines of `width`
 * cells; the last line ends in `…` when text is left over.
 */
export function wrap(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const words = oneLine(text).split(' ').filter(word => word !== '')
  const lines: string[] = []
  let line = ''
  let index = 0
  while (index < words.length && lines.length < maxLines) {
    const word = words[index] as string
    const candidate = line === '' ? word : `${line} ${word}`
    if (cellWidth(candidate) <= width) {
      line = candidate
      index += 1
    } else if (line === '') {
      // A word longer than the line: break it at the edge.
      const [head, rest] = takeCells(word, width)
      lines.push(head)
      words[index] = rest
    } else {
      lines.push(line)
      line = ''
    }
  }
  if (line !== '' && lines.length < maxLines) lines.push(line)
  if (index < words.length && lines.length > 0) {
    const rest = words.slice(index).join(' ')
    const last = lines[lines.length - 1] as string
    lines[lines.length - 1] = truncate(`${last} ${rest}`, width)
  }
  return lines
}
