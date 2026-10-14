// Shapes shared across the engine modules.

/** A cell rectangle, 0-based and inclusive. */
export interface Rect {
  r0: number
  c0: number
  r1: number
  c1: number
}

/** A parsed cell id, 0-based (see parseCellId in utils/cells.ts). */
export interface CellPos {
  row: number
  col: number
}

/**
 * How a structural op moved row or column indices: old index → new index,
 * or null when that index was deleted (see ref-remap.ts).
 */
export type IndexMap = (index: number) => number | null | undefined
