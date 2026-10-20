// The board's surface module: drawn in the pane's `Client`, on the drawing
// thread, with no `$`. It owns what is the viewer's alone (the selection,
// Done shown or hidden, the container filter, each column's window) and
// posts what needs the hooks module (refresh, open in the browser, the
// detail popup).

import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { BoardMessage, BoardProps, Card } from '../types'
import {
  GUTTER,
  hitTest,
  layoutBoard,
  move,
  resolveSelection,
  rowText,
  scrollOf,
  fullCard,
  TOP_ROWS,
  type CardEntry,
  type Layout,
  type Section,
  type Segment,
  type Tone,
} from './lib/layout'
import { viewColumns } from './lib/model'
import { cellWidth, truncate } from './lib/text'

type BoardState = {
  selected: number | null
  showDone: boolean
  filter: number | null
  /** The highlighted row of the open filter picker; null while it is closed. */
  picker: number | null
  scroll: Record<string, number>
  /** The `seq` of the last `pick` from the hooks module the board has taken. */
  pickSeen: number | null
}

const INITIAL: BoardState = { selected: null, showDone: false, filter: null, picker: null, scroll: {}, pickSeen: null }

const COLOR: Record<Tone, string | undefined> = {
  plain: undefined,
  dim: undefined,
  success: 'success',
  failure: 'error',
  pending: 'warning',
}

const ARROWS = new Set(['up', 'down', 'left', 'right'])

function sizeOf(props: BoardProps, surface: ClientSurface<BoardState>) {
  return {
    columns: surface.columns > 0 ? surface.columns : props.columns,
    rows: surface.rows > 0 ? surface.rows : props.rows,
  }
}

function compute(props: BoardProps, state: BoardState, size: { columns: number; rows: number }) {
  if (props.board === null) return null
  const filter = props.board.containers.some(one => one.number === state.filter) ? state.filter : null
  const view = viewColumns(props.board, { showDone: state.showDone, filter })
  const order = view.map(column => column.cards.map(card => card.number))
  // A pick not yet taken wins over the selection, when the card is in view.
  const picked = props.pick !== null && props.pick.seq !== state.pickSeen ? props.pick.number : null
  const isShown = picked !== null && order.some(column => column.includes(picked))
  const selected = resolveSelection(order, isShown ? picked : state.selected)
  return { filter, selected, layout: layoutBoard(view, size, selected, state.scroll) }
}

/** The picker's rows: every task, then each container. */
function pickerRows(props: BoardProps): { filter: number | null; label: string }[] {
  const cards = props.board?.cards ?? []
  return [
    { filter: null, label: 'All tasks' },
    ...(props.board?.containers ?? []).map(one => ({
      filter: one.number,
      label: `#${one.number} ${one.title} (${cards.filter(card => card.parent === one.number).length})`,
    })),
  ]
}

/** The picker rows in view: as many as fit under its title, the highlighted one among them. */
function pickerWindow(props: BoardProps, state: BoardState, rows: number) {
  const all = pickerRows(props)
  const room = Math.max(1, rows - TOP_ROWS - 1)
  const highlighted = state.picker ?? 0
  const first = Math.max(0, Math.min(highlighted - room + 1, all.length - room))
  return { all, first, highlighted, shown: all.slice(first, first + room) }
}

function clockOf(time: number): string {
  const at = new Date(time)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

const Board: ClientModule<BoardProps, BoardState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const stored = surface.state ?? INITIAL
  const size = sizeOf(props, surface)
  const computed = compute(props, stored, size)
  const post = (message: BoardMessage) => surface.post(message)
  // What every input starts from: the selection on screen, the pick taken.
  const state: BoardState = {
    ...stored,
    selected: computed?.selected ?? stored.selected,
    pickSeen: props.pick?.seq ?? null,
  }

  const select = (selected: number | null) => {
    const next = { ...state, selected }
    const relaid = compute(props, next, size)
    surface.setState({ ...next, scroll: relaid === null ? state.scroll : scrollOf(relaid.layout) })
  }

  surface.onKey((event: ClientKeyEvent) => {
    if (state.picker !== null) {
      const rows = pickerRows(props)
      if (event.key === 'up') surface.setState({ ...state, picker: Math.max(0, state.picker - 1) })
      if (event.key === 'down') surface.setState({ ...state, picker: Math.min(rows.length - 1, state.picker + 1) })
      if (event.key === 'f') surface.setState({ ...state, picker: null })
      if (event.key === 'return') {
        const filter = rows[state.picker]?.filter ?? null
        surface.setState({ ...state, picker: null, filter, scroll: {} })
      }
      return
    }
    if (computed === null) {
      if (event.key === 'r') post({ type: 'refresh' })
      return
    }
    if (ARROWS.has(event.key)) {
      select(move(computed.layout, computed.selected, event.key as 'up' | 'down' | 'left' | 'right'))
      return
    }
    switch (event.key) {
      case 'return':
        if (computed.selected !== null) {
          surface.setState(state)
          post({ type: 'detail', number: computed.selected })
        }
        return
      case 'o':
        if (computed.selected !== null) post({ type: 'open', number: computed.selected })
        return
      case 'p':
      case 'P':
        // The hooks module writes it, or says in a toast why it cannot.
        if (computed.selected !== null) {
          const action = event.key === 'P' || event.shift === true ? 'clear' : 'cycle'
          post({ type: 'priority', number: computed.selected, action })
        }
        return
      case 'r':
        post({ type: 'refresh' })
        return
      case 'd':
        surface.setState({ ...state, showDone: !state.showDone, scroll: {} })
        return
      case 'f': {
        const at = pickerRows(props).findIndex(row => row.filter === computed.filter)
        surface.setState({ ...state, picker: Math.max(0, at) })
        return
      }
    }
  })

  surface.onPointer(event => {
    if (event.type !== 'down' || event.button !== 'left') return
    if (state.picker !== null) {
      const picker = pickerWindow(props, state, size.rows)
      const row = picker.shown[event.y - TOP_ROWS - 1]
      if (row !== undefined) surface.setState({ ...state, picker: null, filter: row.filter, scroll: {} })
      return
    }
    if (computed === null) return
    const number = hitTest(computed.layout, event.x, event.y)
    if (number !== null) select(number)
  })

  const statusBar = () => {
    const parts: Segment[] = []
    const board = props.board
    parts.push({ text: board?.repo ?? 'kanban-board', tone: 'plain' })
    if (computed?.filter != null) {
      const container = board?.containers.find(one => one.number === computed.filter)
      parts.push({ text: `  filter #${computed.filter} ${container?.title ?? ''}`, tone: 'pending' })
    }
    if (state.showDone) parts.push({ text: '  +done', tone: 'dim' })
    if (props.status.error !== null) parts.push({ text: `  ⚠ ${props.status.error}`, tone: 'failure' })
    else if (props.status.isLoading) parts.push({ text: '  refreshing…', tone: 'dim' })
    else if (board != null) parts.push({ text: `  updated ${clockOf(board.updatedAt)}`, tone: 'dim' })

    const priorityHint = board?.priorityOff === null ? '  p/P priority' : ''
    const hints = props.isFocused
      ? `←↑↓→ ⏎ details  o open${priorityHint}  r refresh  d done  f filter`
      : 'click the board for keys'
    const left = parts.reduce((sum, part) => sum + cellWidth(part.text), 0)
    const room = size.columns - left - 2
    return (
      <Box flexDirection="row" height={1} width={size.columns}>
        {parts.map(part => (
          <Text color={COLOR[part.tone]} dimColor={part.tone === 'dim'} wrap="truncate">
            {part.text}
          </Text>
        ))}
        {room >= 8 && (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor wrap="truncate">
              {truncate(hints, room)}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const cardView = (entry: CardEntry, width: number, selected: number | null) => {
    const card: Card = entry.card
    const isSelected = card.number === selected
    const mark = isSelected ? '▌ ' : '  '
    if (!entry.isFull) {
      return (
        <Text wrap="truncate">
          {mark}
          {rowText(card, width - GUTTER)}
        </Text>
      )
    }
    const lines = fullCard(card, width - GUTTER)
    return (
      <Box flexDirection="column" height={entry.height}>
        {lines.title.map(line => (
          <Box flexDirection="row">
            <Text color="claude">{mark}</Text>
            <Text bold={isSelected} inverse={isSelected} wrap="truncate">
              {line}
            </Text>
          </Box>
        ))}
        {lines.meta.length > 0 && (
          <Box flexDirection="row">
            <Text color="claude">{mark}</Text>
            {lines.meta.map(part => (
              <Text color={COLOR[part.tone]} dimColor={part.tone === 'dim'} wrap="truncate">
                {part.text}
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
      </Box>
    )
  }

  const sectionView = (one: Section, selected: number | null) => {
    const used = one.entries.reduce((sum, entry) => sum + (entry.kind === 'card' ? entry.height : 1), 0)
    const room = one.isScrolled ? Math.max(0, one.bodyRows - 2) : one.bodyRows
    return (
      <Box flexDirection="column" width={one.width} height={size.rows - TOP_ROWS} overflow="hidden">
        {one.header !== null && (
          <Text bold dimColor={one.header.count === 0} wrap="truncate">
            {one.header.count === 0 ? ` ${one.header.title}` : `${one.header.title} ${one.header.count}`}
          </Text>
        )}
        {one.header !== null && <Text dimColor>{'─'.repeat(one.width)}</Text>}
        {one.isScrolled && <Text dimColor>{one.above > 0 ? `  ↑ ${one.above} more` : ' '}</Text>}
        {one.entries.map(entry =>
          entry.kind === 'header' ? (
            <Text bold dimColor={entry.count === 0} wrap="truncate">
              {entry.count === 0 ? entry.title : `${entry.title} ${entry.count}`}
            </Text>
          ) : (
            cardView(entry, one.width, selected)
          ),
        )}
        {one.isScrolled && room > used && <Box height={room - used} />}
        {one.isScrolled && one.below > 0 && <Text dimColor>{`  ↓ ${one.below} more`}</Text>}
      </Box>
    )
  }

  const pickerView = () => {
    const { first, highlighted, shown } = pickerWindow(props, state, size.rows)
    return (
      <Box flexDirection="column">
        <Text bold>Filter by container (↑↓, Enter, f closes)</Text>
        {shown.map((row, index) => (
          <Text inverse={first + index === highlighted} wrap="truncate">
            {truncate(`  ${row.label}`, size.columns)}
          </Text>
        ))}
      </Box>
    )
  }

  const body = (layout: Layout, selected: number | null) => (
    <Box flexDirection="row" columnGap={1} height={size.rows - TOP_ROWS}>
      {layout.sections.map(one => sectionView(one, selected))}
    </Box>
  )

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows} overflow="hidden">
      {statusBar()}
      {state.picker !== null
        ? pickerView()
        : computed === null
          ? (
              <Text dimColor={props.status.error === null}>
                {props.status.error === null
                  ? 'Loading issues…'
                  : `Could not load the board: ${props.status.error}. Press r to try again.`}
              </Text>
            )
          : body(computed.layout, computed.selected)}
    </Box>
  )
}

export default Board
