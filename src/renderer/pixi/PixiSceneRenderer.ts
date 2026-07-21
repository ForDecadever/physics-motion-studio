import { Application, Container, Graphics } from 'pixi.js'

import { getAdaptiveGridStep, type Camera2D, type ViewportSize } from '../../editor/camera/viewport'
import {
  add,
  getEntityBounds,
  resolveConnectorEndpoint,
  rotateVector,
} from '../../editor/geometry/entityGeometry'
import type { EntityId, SceneDocument, SceneEntity, Vec2 } from '../../scene/model/types'
import type { RuntimeBodyState } from '../../physics/worker/messages'
import { resolveRenderedEntity } from './renderEntityState'

export interface PixiRenderState {
  scene: SceneDocument
  camera: Camera2D
  size: ViewportSize
  gridVisible: boolean
  selectedIds: EntityId[]
  previewEntities: Record<EntityId, SceneEntity>
  draftEntity: SceneEntity | null
  marquee: { start: Vec2; end: Vec2 } | null
  connectorStartBodyId: EntityId | null
  runtimeBodies: Record<EntityId, RuntimeBodyState>
}

const colors = {
  gridMinor: 0x6f7782,
  gridMajor: 0x8a929d,
  axisX: 0x62b97c,
  axisY: 0xe35c67,
  ground: 0xd4dae3,
  bodyFill: 0x4e9eeb,
  bodyStroke: 0xb9ddff,
  selection: 0x58a6ff,
  fieldGravity: 0x8a70d6,
  fieldElectric: 0xe2bd59,
  fieldMagnetic: 0x59c6bd,
  connector: 0xf2b55b,
}

function transformedEntities(state: PixiRenderState): SceneEntity[] {
  const visibleLayers = new Set(
    state.scene.layers.filter((layer) => layer.visible).map((layer) => layer.id),
  )
  const entities = state.scene.entities
    .filter((entity) => entity.visible && visibleLayers.has(entity.layerId))
    .map((entity) => resolveRenderedEntity(entity, state.runtimeBodies, state.previewEntities))

  return state.draftEntity ? [...entities, state.draftEntity] : entities
}

function rotatedRectangle(center: Vec2, width: number, height: number, angleRad: number): Vec2[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => add(center, rotateVector(corner, angleRad)))
}

function flattenPoints(points: Vec2[]): number[] {
  return points.flatMap((point) => [point.x, point.y])
}

export class PixiSceneRenderer {
  private readonly app = new Application()
  private readonly world = new Container()
  private readonly grid = new Graphics()
  private readonly fields = new Graphics()
  private readonly grounds = new Graphics()
  private readonly connectors = new Graphics()
  private readonly bodies = new Graphics()
  private readonly overlays = new Graphics()

  async mount(host: HTMLElement): Promise<HTMLCanvasElement> {
    await this.app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      backgroundAlpha: 0,
      autoStart: false,
      preference: 'webgl',
      powerPreference: 'high-performance',
    })

    this.world.addChild(
      this.grid,
      this.fields,
      this.grounds,
      this.connectors,
      this.bodies,
      this.overlays,
    )
    this.app.stage.addChild(this.world)

    const canvas = this.app.canvas
    canvas.className = 'pixi-editor-canvas'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', '可交互的二维物理画布')
    host.appendChild(canvas)
    return canvas
  }

  resize(size: ViewportSize): void {
    this.app.renderer.resize(Math.max(1, size.width), Math.max(1, size.height))
  }

  render(state: PixiRenderState): void {
    const { camera, size } = state
    this.world.position.set(
      size.width / 2 - camera.center.x * camera.pixelsPerMeter,
      size.height / 2 + camera.center.y * camera.pixelsPerMeter,
    )
    this.world.scale.set(camera.pixelsPerMeter, -camera.pixelsPerMeter)

    this.drawGrid(state)
    const entities = transformedEntities(state)
    this.drawFields(entities, camera.pixelsPerMeter)
    this.drawGrounds(entities, camera.pixelsPerMeter)
    this.drawConnectors(entities, camera.pixelsPerMeter)
    this.drawBodies(entities, camera.pixelsPerMeter)
    this.drawOverlays(state, entities)
    this.app.render()
  }

  destroy(): void {
    this.app.destroy({ removeView: true }, { children: true })
  }

  private drawGrid(state: PixiRenderState): void {
    this.grid.clear()
    if (!state.gridVisible) return

    const { camera, size, scene } = state
    const halfWidth = size.width / (2 * camera.pixelsPerMeter)
    const halfHeight = size.height / (2 * camera.pixelsPerMeter)
    const minX = camera.center.x - halfWidth
    const maxX = camera.center.x + halfWidth
    const minY = camera.center.y - halfHeight
    const maxY = camera.center.y + halfHeight
    const minorStep = getAdaptiveGridStep(scene.settings.gridStep / 10, camera.pixelsPerMeter, 14)
    const majorStep = minorStep * 5
    const lineWidth = 1 / camera.pixelsPerMeter

    const minorLines: Array<[Vec2, Vec2]> = []
    const majorLines: Array<[Vec2, Vec2]> = []

    for (let x = Math.floor(minX / minorStep) * minorStep; x <= maxX; x += minorStep) {
      const target =
        Math.abs(x / majorStep - Math.round(x / majorStep)) < 1e-7 ? majorLines : minorLines
      target.push([
        { x, y: minY },
        { x, y: maxY },
      ])
    }
    for (let y = Math.floor(minY / minorStep) * minorStep; y <= maxY; y += minorStep) {
      const target =
        Math.abs(y / majorStep - Math.round(y / majorStep)) < 1e-7 ? majorLines : minorLines
      target.push([
        { x: minX, y },
        { x: maxX, y },
      ])
    }

    for (const [start, end] of minorLines) {
      this.grid.moveTo(start.x, start.y).lineTo(end.x, end.y)
    }
    this.grid.stroke({ width: lineWidth, color: colors.gridMinor, alpha: 0.17 })
    for (const [start, end] of majorLines) {
      this.grid.moveTo(start.x, start.y).lineTo(end.x, end.y)
    }
    this.grid.stroke({ width: lineWidth, color: colors.gridMajor, alpha: 0.28 })

    this.grid
      .moveTo(minX, 0)
      .lineTo(maxX, 0)
      .stroke({
        width: 1.25 * lineWidth,
        color: colors.axisX,
        alpha: 0.62,
      })
    this.grid
      .moveTo(0, minY)
      .lineTo(0, maxY)
      .stroke({
        width: 1.25 * lineWidth,
        color: colors.axisY,
        alpha: 0.62,
      })
  }

  private drawFields(entities: SceneEntity[], pixelsPerMeter: number): void {
    this.fields.clear()
    const lineWidth = 1.25 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'field' || entity.region.type === 'infinite') continue
      const color =
        entity.field.type === 'uniformGravity'
          ? colors.fieldGravity
          : entity.field.type === 'uniformElectric'
            ? colors.fieldElectric
            : colors.fieldMagnetic

      if (entity.region.type === 'rectangle') {
        this.fields.poly(
          flattenPoints(
            rotatedRectangle(
              entity.region.center,
              entity.region.width,
              entity.region.height,
              entity.region.angleRad,
            ),
          ),
          true,
        )
      } else if (entity.region.type === 'circle') {
        this.fields.circle(entity.region.center.x, entity.region.center.y, entity.region.radius)
      } else {
        this.fields.poly(flattenPoints(entity.region.points), true)
      }

      this.fields.fill({ color, alpha: 0.12 }).stroke({ color, alpha: 0.72, width: lineWidth })
    }
  }

  private drawGrounds(entities: SceneEntity[], pixelsPerMeter: number): void {
    this.grounds.clear()
    const lineWidth = 3 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'ground') continue
      const geometry = entity.geometry
      if (geometry.type === 'line') {
        this.grounds
          .moveTo(geometry.start.x, geometry.start.y)
          .lineTo(geometry.end.x, geometry.end.y)
      } else if (geometry.type === 'arc') {
        this.grounds.arc(
          geometry.center.x,
          geometry.center.y,
          geometry.radius,
          geometry.startRad,
          geometry.endRad,
        )
      } else {
        this.grounds
          .moveTo(geometry.p0.x, geometry.p0.y)
          .bezierCurveTo(
            geometry.p1.x,
            geometry.p1.y,
            geometry.p2.x,
            geometry.p2.y,
            geometry.p3.x,
            geometry.p3.y,
          )
      }
      this.grounds.stroke({ color: colors.ground, alpha: 0.95, width: lineWidth })
    }
  }

  private drawConnectors(entities: SceneEntity[], pixelsPerMeter: number): void {
    this.connectors.clear()
    const lineWidth = 2 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'connector') continue
      const start = resolveConnectorEndpoint(entities, entity.a)
      const end = resolveConnectorEndpoint(entities, entity.b)
      if (!start || !end) continue
      this.connectors.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({
        color: colors.connector,
        alpha: 0.9,
        width: lineWidth,
      })
    }
  }

  private drawBodies(entities: SceneEntity[], pixelsPerMeter: number): void {
    this.bodies.clear()
    const lineWidth = 2 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'body') continue
      const { position, angleRad } = entity.transform
      if (entity.shape.type === 'box') {
        this.bodies.poly(
          flattenPoints(
            rotatedRectangle(position, entity.shape.width, entity.shape.height, angleRad),
          ),
          true,
        )
      } else {
        const radius =
          entity.shape.type === 'circle' ? entity.shape.radius : entity.shape.collisionRadius
        this.bodies.circle(position.x, position.y, radius)
      }
      this.bodies
        .fill({ color: colors.bodyFill, alpha: 0.9 })
        .stroke({ color: colors.bodyStroke, alpha: 0.95, width: lineWidth })

      const radius =
        entity.shape.type === 'circle'
          ? entity.shape.radius
          : entity.shape.type === 'particle'
            ? entity.shape.collisionRadius
            : Math.min(entity.shape.width, entity.shape.height) / 2
      const direction = rotateVector({ x: radius * 0.8, y: 0 }, angleRad)
      this.bodies
        .moveTo(position.x, position.y)
        .lineTo(position.x + direction.x, position.y + direction.y)
        .stroke({ color: 0xe9f5ff, alpha: 0.7, width: lineWidth })
    }
  }

  private drawOverlays(state: PixiRenderState, entities: SceneEntity[]): void {
    this.overlays.clear()
    const lineWidth = 1.5 / state.camera.pixelsPerMeter
    const handleRadius = 5 / state.camera.pixelsPerMeter
    const selected = new Set(state.selectedIds)

    for (const entity of entities) {
      if (!selected.has(entity.id)) continue
      const bounds = getEntityBounds(entity)
      if (!bounds) continue
      const padding = 5 / state.camera.pixelsPerMeter
      const minX = bounds.minX - padding
      const minY = bounds.minY - padding
      const width = bounds.maxX - bounds.minX + padding * 2
      const height = bounds.maxY - bounds.minY + padding * 2
      this.overlays
        .rect(minX, minY, width, height)
        .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
      this.overlays
        .circle(minX + width / 2, minY + height + 18 / state.camera.pixelsPerMeter, handleRadius)
        .fill({ color: colors.selection, alpha: 1 })
    }

    if (state.marquee) {
      const minX = Math.min(state.marquee.start.x, state.marquee.end.x)
      const minY = Math.min(state.marquee.start.y, state.marquee.end.y)
      const width = Math.abs(state.marquee.end.x - state.marquee.start.x)
      const height = Math.abs(state.marquee.end.y - state.marquee.start.y)
      this.overlays
        .rect(minX, minY, width, height)
        .fill({ color: colors.selection, alpha: 0.08 })
        .stroke({ color: colors.selection, alpha: 0.9, width: lineWidth })
    }

    if (state.connectorStartBodyId) {
      const body = entities.find(
        (entity) => entity.id === state.connectorStartBodyId && entity.kind === 'body',
      )
      if (body?.kind === 'body') {
        this.overlays
          .circle(
            body.transform.position.x,
            body.transform.position.y,
            10 / state.camera.pixelsPerMeter,
          )
          .stroke({ color: colors.connector, alpha: 1, width: 2 * lineWidth })
      }
    }
  }
}
