// A `Client` outside the engine: the surface a surface module draws on
// (hooks/board.tsx), with its local state, its key and pointer listeners and
// its port, drawn into a grid of cells. The terminal board runs the board's
// own module through it, so the viewer behaves as in the pane.

import type { ClientElements, ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, JsonValue } from 'claude-code'

import { elements, gridOf, paint, Text, type Grid, type Node } from './render'

export type Mounted<P> = {
  /** Draws the module with `props` in `columns` × `rows` cells. */
  draw: (props: P, columns: number, rows: number) => Grid
  key: (event: ClientKeyEvent) => void
  pointer: (event: ClientPointerEvent) => void
}

/**
 * Mounts `module`. `post` takes what it posts; `invalidate` asks for a new
 * draw after a `setState`. A module that throws draws why, as the pane does.
 */
export function mount<P extends JsonValue, S>(
  module: ClientModule<P, S>,
  post: (data: JsonValue) => void,
  invalidate: () => void,
): Mounted<P> {
  let state: S | undefined
  let onKey: ((event: ClientKeyEvent) => void) | null = null
  let onPointer: ((event: ClientPointerEvent) => void) | null = null
  let size = { columns: 0, rows: 0 }
  let fault: string | null = null

  const surface: ClientSurface<S> = {
    elements: elements as unknown as ClientElements,
    get state() {
      return state
    },
    setState: next => {
      state = next
      invalidate()
    },
    get columns() {
      return size.columns
    },
    get rows() {
      return size.rows
    },
    every: (ms, fn) => {
      const id = setInterval(fn, ms)
      return () => clearInterval(id)
    },
    onPointer: fn => {
      onPointer = fn
      return () => {
        if (onPointer === fn) onPointer = null
      }
    },
    onKey: fn => {
      onKey = fn
      return () => {
        if (onKey === fn) onKey = null
      }
    },
    post,
  }

  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error)
      invalidate()
    }
  }

  return {
    draw: (props, columns, rows) => {
      size = { columns, rows }
      const grid = gridOf(columns, rows)
      let tree: Node | null = null
      if (fault === null) {
        try {
          tree = module(props, surface) as unknown as Node
        } catch (error) {
          fault = error instanceof Error ? error.message : String(error)
        }
      }
      if (fault !== null) tree = Text({ color: 'error', children: `The board failed: ${fault}` })
      if (tree !== null) paint(grid, tree, 0, 0, columns, rows)
      return grid
    },
    key: event => guard(() => onKey?.(event)),
    pointer: event => guard(() => onPointer?.(event)),
  }
}
