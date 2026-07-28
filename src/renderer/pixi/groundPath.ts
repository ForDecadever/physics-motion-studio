import type { GroundEntity } from '../../scene/model/types'

export interface GroundPathWriter {
  moveTo(x: number, y: number): unknown
  lineTo(x: number, y: number): unknown
  arc(centerX: number, centerY: number, radius: number, startRad: number, endRad: number): unknown
  bezierCurveTo(
    control1X: number,
    control1Y: number,
    control2X: number,
    control2Y: number,
    endX: number,
    endY: number,
  ): unknown
}

export function appendGroundPath(path: GroundPathWriter, geometry: GroundEntity['geometry']): void {
  if (geometry.type === 'line') {
    path.moveTo(geometry.start.x, geometry.start.y)
    path.lineTo(geometry.end.x, geometry.end.y)
    return
  }

  if (geometry.type === 'arc') {
    path.moveTo(
      geometry.center.x + Math.cos(geometry.startRad) * geometry.radius,
      geometry.center.y + Math.sin(geometry.startRad) * geometry.radius,
    )
    path.arc(
      geometry.center.x,
      geometry.center.y,
      geometry.radius,
      geometry.startRad,
      geometry.endRad,
    )
    return
  }

  path.moveTo(geometry.p0.x, geometry.p0.y)
  path.bezierCurveTo(
    geometry.p1.x,
    geometry.p1.y,
    geometry.p2.x,
    geometry.p2.y,
    geometry.p3.x,
    geometry.p3.y,
  )
}
