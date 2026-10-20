import { describe, expect, test } from 'claude-code/testing'

import { parse } from '../tui/keys'
import { Box, gridOf, linesOf, paint, Text, textOfGrid } from '../tui/render'

describe('the terminal board reads the keys', () => {
  test('special keys by name, characters as typed', async () => {
    const keys = parse('\x1b[A\x1b[B\x1bOC\x1b[D\r\x7f\x1b[3~\x1b[5~\x1b[6~\x1b[H\x1b[4~\tpP ').map(one =>
      one.kind === 'key' ? one.event.key : one.kind,
    )
    expect(keys).toEqual([
      'up', 'down', 'right', 'left', 'return', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'tab', 'p', 'P', ' ',
    ])
  })

  test('a lone ESC is Escape; Shift-Tab and Ctrl-C carry their modifier', async () => {
    expect(parse('\x1b')).toEqual([{ kind: 'key', event: { key: 'escape' } }])
    expect(parse('\x1b[Z')).toEqual([{ kind: 'key', event: { key: 'tab', shift: true } }])
    expect(parse('\x03')).toEqual([{ kind: 'key', event: { key: 'c', ctrl: true } }])
    expect(parse('\x1b[1;2A')).toEqual([{ kind: 'key', event: { key: 'up', shift: true } }])
  })

  test('an SGR mouse press is a pointer down at the cell, from 0; the wheel steps', async () => {
    expect(parse('\x1b[<0;10;5M\x1b[<0;10;5m')).toEqual([
      { kind: 'pointer', event: { type: 'down', x: 9, y: 4, button: 'left' } },
      { kind: 'pointer', event: { type: 'up', x: 9, y: 4, button: 'left' } },
    ])
    expect(parse('\x1b[<64;1;1M\x1b[<65;1;1M')).toEqual([
      { kind: 'wheel', step: -1 },
      { kind: 'wheel', step: 1 },
    ])
  })

  test('an unknown sequence is dropped, the keys around it kept', async () => {
    expect(parse('a\x1b[200~b').map(one => (one.kind === 'key' ? one.event.key : one.kind))).toEqual(['a', 'b'])
  })
})

describe('the terminal board draws the elements in cells', () => {
  const draw = (node: unknown, width: number, height: number) => {
    const grid = gridOf(width, height)
    paint(grid, node as Parameters<typeof paint>[1], 0, 0, width, height)
    return textOfGrid(grid)
  }

  test('a row puts its children side by side; a truncated text ends in …', async () => {
    const node = Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [Box({ width: 5, children: Text({ children: 'ab' }) }), Text({ wrap: 'truncate', children: 'a long title' })],
    })
    expect(draw(node, 12, 1)).toEqual(['ab    a lon…'])
  })

  test('a growing box takes the rest of the row and flex-end puts its text at the right', async () => {
    const node = Box({
      flexDirection: 'row',
      width: 20,
      children: [Text({ children: 'left' }), Box({ flexGrow: 1, justifyContent: 'flex-end', children: Text({ children: 'hint' }) })],
    })
    expect(draw(node, 20, 1)).toEqual(['left            hint'])
  })

  test('a column stacks its children; a fixed height clips what is below', async () => {
    const node = Box({
      flexDirection: 'column',
      children: [
        Box({ flexDirection: 'column', height: 2, children: ['one', 'two', 'three'].map(text => Text({ children: text })) }),
        Text({ children: 'after' }),
      ],
    })
    expect(draw(node, 10, 4)).toEqual(['one', 'two', 'after', ''])
  })

  test('a text that fits keeps its spaces; a longer one wraps at words', async () => {
    const node = Box({ flexDirection: 'row', children: [Text({ children: '▌ ' }), Text({ children: 'x' })] })
    expect(draw(node, 10, 1)).toEqual(['▌ x'])
    expect(draw(Text({ children: 'one two three' }), 8, 3)).toEqual(['one two', 'three', ''])
  })

  test('a wide character takes two cells and is never cut in half', async () => {
    expect(draw(Text({ wrap: 'truncate', children: '漢字かな' }), 5, 1)).toEqual(['漢字…'])
    expect(draw(Box({ width: 3, children: Text({ children: '漢字' }) }), 6, 1)).toEqual(['漢'])
  })

  test('the colours and the selection come out as SGR codes, reset at the end of the line', async () => {
    const grid = gridOf(6, 1)
    paint(grid, Box({ flexDirection: 'row', children: [Text({ color: 'error', children: 'ab' }), Text({ inverse: true, children: 'cd' })] }), 0, 0, 6, 1)
    expect(linesOf(grid)).toEqual(['\x1b[0;31mab\x1b[0;7mcd\x1b[0m  '])
  })
})
