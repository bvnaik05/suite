import { describe, expect, it } from 'vitest'
import { applyLassoSelection, pointInPolygon, shapesIntersectingLasso } from './lasso-selection'
import type { Point } from './geometry'
import type { Shape } from './selection'

const lasso: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

describe('lasso selection', () => {
  it('treats boundary points as inside the lasso', () => {
    expect(pointInPolygon({ x: 10, y: 5 }, lasso)).toBe(true)
  })

  it('selects any object intersecting the lasso', () => {
    const shapes: Shape[] = [
      { id: 'inside', x: 2, y: 2, width: 2, height: 2, rotation: 0, cornerRadius: 0 },
      { id: 'crossing', kind: 'line', start: { x: -5, y: 5 }, end: { x: 15, y: 5 } },
      { id: 'outside', x: 12, y: 12, width: 2, height: 2, rotation: 0, cornerRadius: 0 },
    ]

    expect(shapesIntersectingLasso(shapes, lasso).map(shape => shape.id)).toEqual(['inside', 'crossing'])
  })

  it('selects a shape when the lasso is fully inside it', () => {
    const shape: Shape = { id: 'large', x: -5, y: -5, width: 20, height: 20, rotation: 0, cornerRadius: 0 }

    expect(shapesIntersectingLasso([shape], lasso)).toEqual([shape])
  })

  it('adds and subtracts intersected ids from the current selection', () => {
    expect(applyLassoSelection(['kept'], ['added'], 'add')).toEqual(['kept', 'added'])
    expect(applyLassoSelection(['kept', 'removed'], ['removed'], 'subtract')).toEqual(['kept'])
    expect(applyLassoSelection(['old'], ['replacement'], 'replace')).toEqual(['replacement'])
  })
})
