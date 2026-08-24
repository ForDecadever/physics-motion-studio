import type { ParticleSourceEntity, Vec2 } from '../../scene/model/types'

const LINE_ION_SPACING_M = 0.05
const MIN_LINE_SOURCE_IONS = 2
const MAX_LINE_SOURCE_IONS = 128
const FULL_CIRCLE_TOLERANCE_RAD = 1e-9
const MAX_POINT_SOURCE_IONS = 3600

export interface ParticleEmissionSample {
  t: number
  position: Vec2
  direction: Vec2
}

export function particleEmissionSamples(source: ParticleSourceEntity): ParticleEmissionSample[] {
  const shape = source.shape
  if (shape.type === 'point') {
    const spreadRad = Math.min(Math.PI * 2, Math.max(0, source.spreadRad))
    const isFullCircle = spreadRad >= Math.PI * 2 - FULL_CIRCLE_TOLERANCE_RAD
    const spreadDegrees = (spreadRad * 180) / Math.PI
    const count =
      spreadRad <= FULL_CIRCLE_TOLERANCE_RAD
        ? 1
        : isFullCircle
          ? Math.min(MAX_POINT_SOURCE_IONS, Math.max(1, Math.round(360 * source.densityPerDegree)))
          : Math.min(
              MAX_POINT_SOURCE_IONS,
              Math.max(2, Math.round(spreadDegrees * source.densityPerDegree)),
            )
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 0.5 : isFullCircle ? index / count : index / (count - 1)
      const angleRad = source.directionRad - spreadRad / 2 + spreadRad * t
      return {
        t,
        position: { ...shape.position },
        direction: { x: Math.cos(angleRad), y: Math.sin(angleRad) },
      }
    })
  }

  const { start, end } = shape
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const side = source.flipEmission ? -1 : 1
  if (length <= Number.EPSILON) {
    return [{ t: 0, position: { ...start }, direction: { x: 0, y: side } }]
  }
  const count = Math.max(
    MIN_LINE_SOURCE_IONS,
    Math.min(MAX_LINE_SOURCE_IONS, Math.round(length / LINE_ION_SPACING_M)),
  )
  const direction = { x: (-dy / length) * side, y: (dx / length) * side }
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0 : index / (count - 1)
    return {
      t,
      position: { x: start.x + dx * t, y: start.y + dy * t },
      direction,
    }
  })
}
