// The board's surface module: drawn in the pane's `Client`, on the drawing
// thread, with no `$`. It owns what is the viewer's alone (the selection,
// Done shown or hidden, the container filter, each column's window, where the
// detail view is scrolled to) and posts what needs the hooks module (refresh,
// open in the browser, the issue the detail view shows). The detail view is
// drawn here, not in a pane of its own: only a click gives a `Client` the keys,
// so a second pane would take them from the board for good.

import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { BoardMessage, BoardProps, Card } from '../types'
import { clampScroll, detailLines, placeOf, scrollTo, START_LABEL, walk, type DetailLine } from './lib/detail-view'
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
  /** The issue `detailScroll` and `detailLink` are for: another issue starts at the top. */
  detailFor: number | null
  detailScroll: number
  /** Which of the detail view's links Enter follows, by order. */
  detailLink: number
}

const INITIAL: BoardState = {
  selected: null,
  showDone: false,
  filter: null,
  picker: null,
  scroll: {},
  pickSeen: null,
  detailFor: null,
  detailScroll: 0,
  detailLink: 0,
}

const COLOR: Record<Tone, string | undefined> = {
  plain: undefined,
  dim: undefined,
  success: 'success',
  failure: 'error',
  pending: 'warning',
  accent: 'claude',
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

/** The detail view as drawn: its lines, the window on them, the link Enter follows. */
function detailOf(props: BoardProps, state: BoardState, size: { columns: number; rows: number }) {
  // Absent in the props of a hooks module older than this surface module: a reload swaps the two apart.
  const detail = props.detail ?? null
  if (detail === null) return null
  const lines = detailLines(detail, placeOf(props.board, detail.number), size.columns)
  const rows = Math.max(1, size.rows - TOP_ROWS)
  const isSame = state.detailFor === detail.number
  const links = lines.flatMap((line, index) => (line.link === null ? [] : [index]))
  const link = links.length === 0 ? null : Math.min(isSame ? state.detailLink : 0, links.length - 1)
  const scroll = clampScroll(isSame ? state.detailScroll : 0, lines.length, rows)
  const priority = detail.issue !== null && detail.issue.number === detail.number ? detail.issue.priority : null
  return { number: detail.number, priority, lines, rows, links, link, scroll }
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

  const detail = detailOf(props, state, size)

  /** The detail view's keys (spec section 5): Backspace goes back, the rest scroll, follow a link or act on the issue. */
  const detailKey = (view: NonNullable<typeof detail>, event: ClientKeyEvent) => {
    // From `stored`: the pick of the issue shown last waits for the board, to select it on the way back.
    const at = (scroll: number, link = view.link ?? 0) =>
      surface.setState({
        ...stored,
        detailFor: view.number,
        detailScroll: clampScroll(scroll, view.lines.length, view.rows),
        detailLink: link,
      })
    const toLink = (step: number) => {
      if (view.link === null) return
      const link = (view.link + step + view.links.length) % view.links.length
      at(scrollTo(view.scroll, view.links[link] ?? 0, view.rows), link)
    }
    switch (event.key) {
      case 'backspace':
      case 'delete':
        post({ type: 'back' })
        return
      case 'up':
      case 'down': {
        const step = event.key === 'up' ? -1 : 1
        const next = walk({ ...view, lineCount: view.lines.length }, step)
        if (next.link !== null) at(next.scroll, next.link)
        else at(next.scroll)
        return
      }
      case 'pageup':
        at(view.scroll - view.rows)
        return
      case 'pagedown':
      case 'space':
      case ' ':
        at(view.scroll + view.rows)
        return
      case 'home':
        at(0)
        return
      case 'end':
        at(view.lines.length)
        return
      case 'left':
        toLink(-1)
        return
      case 'right':
        toLink(1)
        return
      case 'tab':
        toLink(event.shift === true ? -1 : 1)
        return
      case 'return': {
        // Only a link on screen: one scrolled away is not what the person looks at.
        const index = view.link === null ? -1 : (view.links[view.link] ?? -1)
        const isOnScreen = index >= view.scroll && index < view.scroll + view.rows
        const number = isOnScreen ? view.lines[index]?.link : null
        if (number != null) post({ type: 'detail', number })
        return
      }
      case 'o':
        post({ type: 'open', number: view.number })
        return
      case 's':
        post({ type: 'start', number: view.number })
        return
      case 'p':
      case 'P': {
        const action = event.key === 'P' || event.shift === true ? 'clear' : 'cycle'
        post({ type: 'priority', number: view.number, action, current: view.priority })
        return
      }
      case 'r':
        post({ type: 'refresh' })
        return
    }
  }

  surface.onKey((event: ClientKeyEvent) => {
    if (detail !== null) {
      detailKey(detail, event)
      return
    }
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
      case 's':
        // The hooks module starts it, or says in a toast why it does not.
        if (computed.selected !== null) post({ type: 'start', number: computed.selected })
        return
      case 'p':
      case 'P':
        // The hooks module writes it, or says in a toast why it cannot.
        if (computed.selected !== null) {
          const number = computed.selected
          const action = event.key === 'P' || event.shift === true ? 'clear' : 'cycle'
          const current = props.board?.cards.find(card => card.number === number)?.priority ?? null
          post({ type: 'priority', number, action, current })
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
    if (detail !== null) {
      // A press on a link shows that issue.
      const number = detail.lines[detail.scroll + event.y - TOP_ROWS]?.link
      if (event.y >= TOP_ROWS && number != null) post({ type: 'detail', number })
      return
    }
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
    if (detail !== null) {
      const last = Math.min(detail.lines.length, detail.scroll + detail.rows)
      parts.push({ text: `  #${detail.number}  ${detail.scroll + 1}–${last} of ${detail.lines.length}`, tone: 'dim' })
    } else if (state.showDone) parts.push({ text: '  +done', tone: 'dim' })
    if (props.status.error !== null) parts.push({ text: `  ⚠ ${props.status.error}`, tone: 'failure' })
    else if (props.status.isLoading) parts.push({ text: '  refreshing…', tone: 'dim' })
    else if (board != null) parts.push({ text: `  updated ${clockOf(board.updatedAt)}`, tone: 'dim' })

    const priorityHint = board?.priorityOff === null ? '  p/P priority' : ''
    const startAs = detail === null ? null : placeOf(board ?? null, detail.number).startAs
    const detailHints = `⌫ back  ↑↓ links, scroll  ⏎ show it${startAs === null ? '' : `  s ${START_LABEL[startAs]}`}  o open${priorityHint}`
    // The board cannot tell whether a click gave it the keys (the pane's focus is another thing): it names them always.
    const hints = detail !== null ? detailHints : `←↑↓→ ⏎ details  s start  o open${priorityHint}  r refresh  d done  f filter`
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

  const detailLineView = (line: DetailLine, isChosen: boolean) => (
    <Box flexDirection="row" height={1}>
      {line.parts.map((part, index) => (
        <Text
          bold={line.isBold}
          color={COLOR[part.tone]}
          dimColor={part.tone === 'dim'}
          inverse={isChosen && index === 1}
          wrap="truncate"
        >
          {part.text === '' ? ' ' : part.text}
        </Text>
      ))}
    </Box>
  )

  const detailView = (view: NonNullable<typeof detail>) => {
    const chosen = view.link === null ? -1 : (view.links[view.link] ?? -1)
    return (
      <Box flexDirection="column" height={view.rows} overflow="hidden">
        {view.lines
          .slice(view.scroll, view.scroll + view.rows)
          .map((line, index) => detailLineView(line, view.scroll + index === chosen))}
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
      {detail !== null
        ? detailView(detail)
        : state.picker !== null
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
