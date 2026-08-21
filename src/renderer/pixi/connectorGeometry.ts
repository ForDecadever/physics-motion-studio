import type { Vec2 } from '../../scene/model/types'

export interface ConnectorLineSegment {
  start: Vec2
  end: Vec2
}

export function createSpringEndBar(
  start: Vec2,
  end: Vec2,
  endpoint: 'start' | 'end',
  halfWidthM: number,
): ConnectorLineSegment {
  const delta = { x: end.x - start.x, y: end.y - start.y }
  const length = Math.hypot(delta.x, delta.y)
  const normal =
    length > Number.EPSILON ? { x: -delta.y / length, y: delta.x / length } : { x: 0, y: 1 }
  const center = endpoint === 'start' ? start : end
  return {
    start: {
      x: center.x - normal.x * halfWidthM,
      y: center.y - normal.y * halfWidthM,
    },
    end: {
      x: center.x + normal.x * halfWidthM,
      y: center.y + normal.y * halfWidthM,
    },
  }
}
