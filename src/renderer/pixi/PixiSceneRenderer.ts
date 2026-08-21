import { Application, Container, Graphics, Rectangle } from 'pixi.js'

import { getVisibleGridSteps, type Camera2D, type ViewportSize } from '../../editor/camera/viewport'
import {
  add,
  createScaleHandleGeometry,
  getEntityBounds,
  getEntityTransform,
  isScalableEntity,
  resolveConnectorEndpoint,
  rotateVector,
} from '../../editor/geometry/entityGeometry'
import {
  listEditingSelectionTargets,
  selectionTargetBounds,
} from '../../editor/geometry/selectionTargets'
import { resolveGroundEndpoint, resolveGroundJoint } from '../../scene/model/groundEndpoints'
import {
  booleanGeometryRings,
  resolveBooleanScene,
  transformBooleanBodyGeometry,
  type BooleanMultiPolygon,
  type ResolvedBooleanBody,
  type ResolvedBooleanResult,
} from '../../scene/model/booleanGeometry'
import {
  analyzeBezierBodyPath,
  sampleBezierBodyWorldPoints,
  worldBezierPathNodes,
} from '../../scene/model/bodyPath'
import {
  findBooleanNode,
  isTreeItemEffectivelyLocked,
  isTreeItemEffectivelyVisible,
} from '../../scene/model/booleanLayerGraph'
import type {
  GroundPath as ResolvedGroundPath,
  GroundPathNetwork,
} from '../../scene/model/groundPath'
import type {
  ConnectorEndpoint,
  ConnectorEntity,
  EntityId,
  GroundEndpointRef,
  ParticleSourceEntity,
  SceneDocument,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import type { EditorTool } from '../../stores/editorStore'
import type { RuntimeBodyState, RuntimeConnectorState } from '../../physics/worker/messages'
import { createSpringEndBar } from './connectorGeometry'
import { appendGroundPath } from './groundPath'
import { AUTO_JOINT_PREVIEW_ID, GroundRenderNetworkCache } from './groundNetworkCache'
import { resolveBooleanBodyRenderTransform, resolveRenderedEntity } from './renderEntityState'
import { sceneContentPaintOrder } from './sceneContentOrder'

export interface PixiRenderState {
  scene: SceneDocument
  camera: Camera2D
  size: ViewportSize
  gridVisible: boolean
  selectedIds: EntityId[]
  previewEntities: Record<EntityId, SceneEntity>
  draftEntity: SceneEntity | null
  marquee: { start: Vec2; end: Vec2 } | null
  connectorStartEndpoint: ConnectorEndpoint | null
  activeTool: EditorTool
  groundJointStart: GroundEndpointRef | null
  groundJointHover: GroundEndpointRef | null
  pendingGroundEndpoint: GroundEndpointRef | null
  runtimeBodies: Record<EntityId, RuntimeBodyState>
  runtimeConnectors: Record<EntityId, RuntimeConnectorState>
  runtimeTrajectories: Record<EntityId, Vec2[]>
  particleTrajectories: Array<{ t: number; points: Vec2[] }>
  runtimeLocked: boolean
  motionGuides?: {
    trajectoryIds: EntityId[]
    velocityIds: EntityId[]
    forceIds: EntityId[]
    trajectoryColors?: Record<EntityId, string>
  }
  showOverlays?: boolean
  backgroundColor?: string
  transparentBackground?: boolean
}

interface PixiMountOptions {
  width?: number
  height?: number
  resolution?: number
  interactive?: boolean
  ariaLabel?: string
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
  groundJoint: 0x72d6a0,
  groundJointInvalid: 0xe45d68,
  particleSource: 0x9dd0ff,
  trajectory: 0x78d6c6,
  velocity: 0x73c7ff,
  force: 0xffb45e,
  collisionOn: 0xe45d68,
  collisionOff: 0x4e9eeb,
  booleanBodyFill: 0x725bd8,
  booleanBodyStroke: 0xd8d0ff,
  booleanInvalid: 0xf2b55b,
}

const TAU = Math.PI * 2

function ionTrajectoryColor(t: number): number {
  const hue = Math.min(1, Math.max(0, t)) * 300
  const h = hue / 60
  const chroma = 0.85
  const x = chroma * (1 - Math.abs((h % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (h < 1) {
    r = chroma
    g = x
  } else if (h < 2) {
    r = x
    g = chroma
  } else if (h < 3) {
    g = chroma
    b = x
  } else if (h < 4) {
    g = x
    b = chroma
  } else if (h < 5) {
    r = x
    b = chroma
  } else {
    r = chroma
    b = x
  }
  const floor = 0.12
  const rr = Math.round((r + floor) * 255)
  const gg = Math.round((g + floor) * 255)
  const bb = Math.round((b + floor) * 255)
  return (rr << 16) | (gg << 8) | bb
}

function particleEmissionDirection(entity: ParticleSourceEntity): Vec2 {
  if (entity.shape.type === 'point') {
    return { x: Math.cos(entity.directionRad), y: Math.sin(entity.directionRad) }
  }
  const { start, end } = entity.shape
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  const side = entity.flipEmission ? -1 : 1
  if (length <= Number.EPSILON) return { x: 0, y: side }
  return { x: (-dy / length) * side, y: (dx / length) * side }
}

function drawArrow(
  graphics: Graphics,
  from: Vec2,
  direction: Vec2,
  length: number,
  width: number,
  color: number,
): void {
  const tip = { x: from.x + direction.x * length, y: from.y + direction.y * length }
  const headLength = length * 0.35
  const headWidth = length * 0.22
  const back = { x: tip.x - direction.x * headLength, y: tip.y - direction.y * headLength }
  const perpendicular = { x: -direction.y, y: direction.x }
  const left = { x: back.x + perpendicular.x * headWidth, y: back.y + perpendicular.y * headWidth }
  const right = { x: back.x - perpendicular.x * headWidth, y: back.y - perpendicular.y * headWidth }
  graphics
    .moveTo(from.x, from.y)
    .lineTo(tip.x, tip.y)
    .moveTo(tip.x, tip.y)
    .lineTo(left.x, left.y)
    .moveTo(tip.x, tip.y)
    .lineTo(right.x, right.y)
    .stroke({ color, alpha: 0.9, width })
}

function transformedEntities(state: PixiRenderState): SceneEntity[] {
  const booleanSourceIds = new Set(
    resolveBooleanScene(state.scene).roots.flatMap((result) => result.sourceEntityIds),
  )
  const selected = new Set(state.selectedIds)
  const entities = state.scene.entities
    .filter(
      (entity) =>
        isTreeItemEffectivelyVisible(state.scene.rootItems, entity.id) &&
        (booleanSourceIds.has(entity.id) ? selected.has(entity.id) : entity.visible),
    )
    .map((entity) => resolveRenderedEntity(entity, state.runtimeBodies, state.previewEntities))

  return state.draftEntity ? [...entities, state.draftEntity] : entities
}

function appendResolvedGroundPath(graphics: Graphics, path: ResolvedGroundPath): void {
  const points = path.sample()
  const first = points[0]
  if (!first) return
  graphics.moveTo(first.x, first.y)
  for (const point of points.slice(1)) graphics.lineTo(point.x, point.y)
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

function appendBooleanGeometry(
  graphics: Graphics,
  geometry: BooleanMultiPolygon,
  fill: { color: number; alpha: number } | null,
  stroke: { color: number; alpha: number; width: number },
): void {
  for (const polygon of booleanGeometryRings(geometry)) {
    const outer = polygon[0]
    if (!outer || outer.length < 3) continue
    graphics.poly(flattenPoints(outer), true)
    if (fill) {
      graphics.fill(fill)
      for (const hole of polygon.slice(1)) {
        if (hole.length >= 3) graphics.poly(flattenPoints(hole), true).cut()
      }
    }
    graphics.poly(flattenPoints(outer), true).stroke(stroke)
    for (const hole of polygon.slice(1)) {
      if (hole.length >= 3) graphics.poly(flattenPoints(hole), true).stroke(stroke)
    }
  }
}

function rigidBooleanPreviewTransform(
  result: ResolvedBooleanBody,
  sceneEntities: readonly SceneEntity[],
  previewEntities: Record<EntityId, SceneEntity>,
): { position: Vec2; angleRad: number } | null {
  if (result.sourceEntityIds.length === 0) return null
  const entityById = new Map(sceneEntities.map((entity) => [entity.id, entity]))
  const referenceId = result.sourceEntityIds[0]!
  const reference = entityById.get(referenceId)
  const referencePreview = previewEntities[referenceId]
  const referenceTransform = reference ? getEntityTransform(reference) : null
  const referencePreviewTransform = referencePreview ? getEntityTransform(referencePreview) : null
  if (!reference || !referencePreview || !referenceTransform || !referencePreviewTransform)
    return null
  if (
    (reference.kind === 'body' &&
      (referencePreview.kind !== 'body' || referencePreview.shape !== reference.shape)) ||
    (reference.kind === 'field' &&
      (referencePreview.kind !== 'field' || referencePreview.region !== reference.region))
  ) {
    return null
  }
  const angleDelta = referencePreviewTransform.angleRad - referenceTransform.angleRad
  const cosine = Math.cos(angleDelta)
  const sine = Math.sin(angleDelta)
  const translation = {
    x:
      referencePreviewTransform.position.x -
      (referenceTransform.position.x * cosine - referenceTransform.position.y * sine),
    y:
      referencePreviewTransform.position.y -
      (referenceTransform.position.x * sine + referenceTransform.position.y * cosine),
  }
  for (const sourceId of result.sourceEntityIds) {
    const source = entityById.get(sourceId)
    const preview = previewEntities[sourceId]
    const sourceTransform = source ? getEntityTransform(source) : null
    const previewTransform = preview ? getEntityTransform(preview) : null
    if (!source || !preview || !sourceTransform || !previewTransform) return null
    if (
      (source.kind === 'body' && (preview.kind !== 'body' || preview.shape !== source.shape)) ||
      (source.kind === 'field' && (preview.kind !== 'field' || preview.region !== source.region))
    ) {
      return null
    }
    const expected = {
      x: sourceTransform.position.x * cosine - sourceTransform.position.y * sine + translation.x,
      y: sourceTransform.position.x * sine + sourceTransform.position.y * cosine + translation.y,
    }
    if (
      Math.abs(previewTransform.angleRad - sourceTransform.angleRad - angleDelta) > 1e-9 ||
      Math.hypot(
        previewTransform.position.x - expected.x,
        previewTransform.position.y - expected.y,
      ) > 1e-8
    ) {
      return null
    }
  }
  return {
    position: {
      x: result.centerOfMass.x * cosine - result.centerOfMass.y * sine + translation.x,
      y: result.centerOfMass.x * sine + result.centerOfMass.y * cosine + translation.y,
    },
    angleRad: result.angleRad + angleDelta,
  }
}

export class PixiSceneRenderer {
  private readonly app = new Application()
  private readonly world = new Container()
  private readonly grid = new Graphics()
  private readonly content = new Graphics()
  private readonly groundJoints = new Graphics()
  private readonly motionGuides = new Graphics()
  private readonly overlays = new Graphics()
  private readonly groundNetworkCache = new GroundRenderNetworkCache()
  private captureBackgroundColor = '#000000'
  private captureTransparent = true
  private initialized = false

  async mount(host: HTMLElement, options: PixiMountOptions = {}): Promise<HTMLCanvasElement> {
    await this.app.init({
      width: Math.max(1, options.width ?? host.clientWidth),
      height: Math.max(1, options.height ?? host.clientHeight),
      antialias: true,
      autoDensity: true,
      resolution: options.resolution ?? Math.min(window.devicePixelRatio || 1, 2),
      backgroundAlpha: 0,
      autoStart: false,
      preference: 'webgl',
      powerPreference: 'high-performance',
    })
    this.initialized = true

    this.world.addChild(
      this.grid,
      this.content,
      this.groundJoints,
      this.motionGuides,
      this.overlays,
    )
    this.app.stage.addChild(this.world)

    const canvas = this.app.canvas
    canvas.className = 'pixi-editor-canvas'
    if (options.interactive !== false) {
      canvas.tabIndex = 0
      canvas.setAttribute('role', 'application')
    } else {
      canvas.tabIndex = -1
      canvas.setAttribute('role', 'img')
    }
    canvas.setAttribute('aria-label', options.ariaLabel ?? '可交互的二维物理画布')
    host.appendChild(canvas)
    return canvas
  }

  resize(size: ViewportSize): void {
    if (!this.initialized) throw new Error('画布渲染器尚未初始化，无法调整尺寸。')
    this.app.renderer.resize(Math.max(1, size.width), Math.max(1, size.height))
  }

  render(state: PixiRenderState): void {
    if (!this.initialized) throw new Error('画布渲染器尚未初始化，无法绘制画面。')
    const { camera, size } = state
    this.captureBackgroundColor = state.backgroundColor ?? '#000000'
    this.captureTransparent = state.transparentBackground ?? true
    this.app.renderer.background.color = this.captureBackgroundColor
    this.app.renderer.background.alpha = this.captureTransparent ? 0 : 1
    this.world.position.set(
      size.width / 2 - camera.center.x * camera.pixelsPerMeter,
      size.height / 2 + camera.center.y * camera.pixelsPerMeter,
    )
    this.world.scale.set(camera.pixelsPerMeter, -camera.pixelsPerMeter)

    this.drawGrid(state)
    const entities = transformedEntities(state)
    const baseBooleanScene = resolveBooleanScene(state.scene)
    const previewIds = new Set(Object.keys(state.previewEntities))
    const rigidPreviewTransforms = new Map<EntityId, { position: Vec2; angleRad: number }>()
    let requiresBooleanRebuild = false
    for (const result of baseBooleanScene.roots) {
      const hasSourcePreview = result.sourceEntityIds.some((id) => previewIds.has(id))
      if (!hasSourcePreview) continue
      if (result.valid && result.kind === 'body') {
        const rigidTransform = rigidBooleanPreviewTransform(
          result,
          state.scene.entities,
          state.previewEntities,
        )
        if (rigidTransform) {
          rigidPreviewTransforms.set(result.resultId, rigidTransform)
          continue
        }
      }
      requiresBooleanRebuild = true
    }
    const booleanScene = requiresBooleanRebuild
      ? resolveBooleanScene({
          ...state.scene,
          entities: state.scene.entities.map(
            (entity) => state.previewEntities[entity.id] ?? entity,
          ),
        })
      : baseBooleanScene
    const booleanBodyTransforms = new Map(
      booleanScene.roots.flatMap((result) => {
        if (!result.valid || result.kind !== 'body') return []
        return [
          [
            result.resultId,
            rigidPreviewTransforms.get(result.resultId) ??
              resolveBooleanBodyRenderTransform(
                result,
                state.runtimeBodies[result.resultId],
                result.sourceEntityIds.some((id) => previewIds.has(id)),
              ),
          ] as const,
        ]
      }),
    )
    const groundRender = this.groundNetworkCache.resolve(
      entities,
      state.draftEntity,
      state.pendingGroundEndpoint,
      state.groundJointStart,
      state.groundJointHover,
    )
    this.content.clear()
    const entityById = new Map(entities.map((entity) => [entity.id, entity]))
    const resultById = new Map(booleanScene.roots.map((result) => [result.resultId, result]))
    const rootEntityIds = new Set(
      state.scene.rootItems.flatMap((item) => (item.kind === 'entity' ? [item.entityId] : [])),
    )
    for (const targetId of sceneContentPaintOrder(state.scene.rootItems)) {
      const item = state.scene.rootItems.find(
        (candidate) =>
          (candidate.kind === 'entity' ? candidate.entityId : candidate.resultId) === targetId,
      )
      if (!item) continue
      if (item.kind === 'boolean') {
        const result = resultById.get(item.resultId)
        if (!result) continue
        this.drawBooleanFields(state, [result])
        this.drawBooleanBodies(state, [result], booleanBodyTransforms)
        continue
      }
      const entity = entityById.get(item.entityId)
      if (!entity) continue
      this.drawEntityContent(state, entities, entity, groundRender.network, booleanBodyTransforms)
    }
    for (const entity of entities) {
      if (rootEntityIds.has(entity.id)) continue
      this.drawEntityContent(state, entities, entity, groundRender.network, booleanBodyTransforms)
    }
    this.drawParticleTrajectories(state)
    this.drawGroundJoints(state, entities, groundRender.network, groundRender.previewJointId)
    this.drawMotionGuides(state)
    this.drawOverlays(state, entities, groundRender.network, booleanBodyTransforms)
    this.drawBooleanOverlays(state, booleanScene.roots, booleanBodyTransforms)
    this.app.render()
  }

  private drawEntityContent(
    state: PixiRenderState,
    allEntities: SceneEntity[],
    entity: SceneEntity,
    groundPathNetwork: GroundPathNetwork,
    booleanBodyTransforms: ReadonlyMap<EntityId, { position: Vec2; angleRad: number }>,
  ): void {
    if (entity.kind === 'field') {
      this.drawFields(state, [entity])
      return
    }
    if (entity.kind === 'ground' || entity.kind === 'groundJoint') {
      this.drawGrounds(allEntities, groundPathNetwork, state.camera.pixelsPerMeter, entity.id)
      return
    }
    if (entity.kind === 'connector') {
      this.drawConnectors(
        allEntities,
        groundPathNetwork,
        state.camera.pixelsPerMeter,
        state.runtimeConnectors,
        booleanBodyTransforms,
        entity.id,
      )
      return
    }
    if (entity.kind === 'particleSource') {
      this.drawParticleSource(state, entity)
      return
    }
    this.drawBodies([entity], state.camera.pixelsPerMeter)
    if (
      entity === state.draftEntity &&
      entity.kind === 'body' &&
      entity.shape.type === 'bezierPath'
    ) {
      const analysis = analyzeBezierBodyPath(worldBezierPathNodes(entity))
      if (!analysis.valid && analysis.sampledPoints.length > 1) {
        const invalidSegments =
          analysis.invalidSegmentIndices.length > 0
            ? analysis.invalidSegmentIndices
            : analysis.sampledPoints.map((_, index) => index)
        for (const index of invalidSegments) {
          const start = analysis.sampledPoints[index]
          const end = analysis.sampledPoints[(index + 1) % analysis.sampledPoints.length]
          if (!start || !end) continue
          this.content.moveTo(start.x, start.y).lineTo(end.x, end.y)
        }
        this.content.stroke({
          color: colors.booleanInvalid,
          alpha: 1,
          width: 2.5 / state.camera.pixelsPerMeter,
        })
      }
    }
  }

  destroy(): void {
    if (!this.initialized) return
    this.initialized = false
    this.app.destroy({ removeView: true }, { children: true })
  }

  capturePixels(size: ViewportSize): Uint8ClampedArray {
    if (!this.initialized) throw new Error('画布渲染器尚未初始化，无法读取像素。')
    const { pixels } = this.app.renderer.extract.pixels({
      target: this.app.stage,
      frame: new Rectangle(0, 0, size.width, size.height),
      resolution: 1,
      clearColor: this.captureTransparent ? [0, 0, 0, 0] : this.captureBackgroundColor,
    })
    return pixels
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
    const { minorStep, majorStep } = getVisibleGridSteps(
      scene.settings.gridStep,
      camera.pixelsPerMeter,
    )
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

  private drawParticleSource(state: PixiRenderState, entity: ParticleSourceEntity): void {
    const pixelsPerMeter = state.camera.pixelsPerMeter
    const color = colors.particleSource
    const glyphRadius = 6 / pixelsPerMeter
    const arrowLength = 14 / pixelsPerMeter
    const strokeWidth = 1.5 / pixelsPerMeter
    const direction = particleEmissionDirection(entity)

    if (entity.shape.type === 'point') {
      const p = entity.shape.position
      this.content.circle(p.x, p.y, glyphRadius).fill({ color, alpha: 0.9 })
      drawArrow(this.content, p, direction, arrowLength, strokeWidth, color)
      return
    }

    const { start, end } = entity.shape
    this.content
      .moveTo(start.x, start.y)
      .lineTo(end.x, end.y)
      .stroke({ color, alpha: 0.9, width: strokeWidth })
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    drawArrow(this.content, midpoint, direction, arrowLength, strokeWidth, color)
  }

  private drawParticleTrajectories(state: PixiRenderState): void {
    if (state.particleTrajectories.length === 0) return
    const width = 1.5 / state.camera.pixelsPerMeter
    for (const trajectory of state.particleTrajectories) {
      const points = trajectory.points
      if (points.length < 2) continue
      const color = ionTrajectoryColor(trajectory.t)
      this.content.moveTo(points[0]!.x, points[0]!.y)
      for (let index = 1; index < points.length; index += 1) {
        this.content.lineTo(points[index]!.x, points[index]!.y)
      }
      this.content.stroke({ color, alpha: 0.9, width })
    }
  }

  private drawFields(state: PixiRenderState, entities: SceneEntity[]): void {
    const { camera, size } = state
    const pixelsPerMeter = camera.pixelsPerMeter
    const lineWidth = 1.25 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'field') continue
      const color =
        entity.field.type === 'uniformGravity'
          ? colors.fieldGravity
          : entity.field.type === 'uniformElectric'
            ? colors.fieldElectric
            : colors.fieldMagnetic

      if (entity.region.type === 'infinite') {
        const width = size.width / pixelsPerMeter
        const height = size.height / pixelsPerMeter
        this.content.rect(camera.center.x - width / 2, camera.center.y - height / 2, width, height)
      } else if (entity.region.type === 'rectangle') {
        this.content.poly(
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
        if (Math.abs(entity.region.sweepRad) >= TAU - 1e-7) {
          this.content.circle(entity.region.center.x, entity.region.center.y, entity.region.radius)
        } else {
          const start = {
            x: entity.region.center.x + Math.cos(entity.region.startRad) * entity.region.radius,
            y: entity.region.center.y + Math.sin(entity.region.startRad) * entity.region.radius,
          }
          this.content
            .moveTo(entity.region.center.x, entity.region.center.y)
            .lineTo(start.x, start.y)
            .arc(
              entity.region.center.x,
              entity.region.center.y,
              entity.region.radius,
              entity.region.startRad,
              entity.region.startRad + entity.region.sweepRad,
              entity.region.sweepRad < 0,
            )
            .closePath()
        }
      } else if (entity.region.type === 'polygon') {
        this.content.poly(flattenPoints(entity.region.points), true)
      } else {
        const first = entity.region.nodes[0]
        if (first) {
          this.content.moveTo(first.anchor.x, first.anchor.y)
          for (let index = 0; index < entity.region.nodes.length; index += 1) {
            const current = entity.region.nodes[index]
            const next = entity.region.nodes[(index + 1) % entity.region.nodes.length]
            if (!current || !next) continue
            this.content.bezierCurveTo(
              current.outHandle.x,
              current.outHandle.y,
              next.inHandle.x,
              next.inHandle.y,
              next.anchor.x,
              next.anchor.y,
            )
          }
          this.content.closePath()
        }
      }

      this.content.fill({ color, alpha: 0.12 }).stroke({ color, alpha: 0.72, width: lineWidth })
      this.drawFieldLegend(entity, state, color)
    }
  }

  private drawFieldLegend(
    entity: Extract<SceneEntity, { kind: 'field' }>,
    state: PixiRenderState,
    color: number,
  ): void {
    const pixelsPerMeter = state.camera.pixelsPerMeter
    let position = state.camera.center
    const region = entity.region
    if (region.type === 'rectangle' || region.type === 'circle') position = region.center
    if (region.type === 'polygon' && region.points.length > 0) {
      position = region.points.reduce(
        (sum, point) => ({
          x: sum.x + point.x / region.points.length,
          y: sum.y + point.y / region.points.length,
        }),
        { x: 0, y: 0 },
      )
    }
    if (region.type === 'bezierPath' && region.nodes.length > 0) {
      position = region.nodes.reduce(
        (sum, node) => ({
          x: sum.x + node.anchor.x / region.nodes.length,
          y: sum.y + node.anchor.y / region.nodes.length,
        }),
        { x: 0, y: 0 },
      )
    }

    if (entity.field.type === 'uniformMagnetic') {
      const magnitude = Math.abs(entity.field.bzTesla)
      const radius = Math.min(14, 8 + 2 * Math.log10(1 + magnitude)) / pixelsPerMeter
      const stroke = { color, alpha: 1, width: 2 / pixelsPerMeter }
      this.content.circle(position.x, position.y, radius).stroke(stroke)
      if (entity.field.bzTesla >= 0) {
        this.content.circle(position.x, position.y, 2.2 / pixelsPerMeter).fill({ color, alpha: 1 })
      } else {
        const diagonal = radius * 0.55
        this.content
          .moveTo(position.x - diagonal, position.y - diagonal)
          .lineTo(position.x + diagonal, position.y + diagonal)
          .moveTo(position.x - diagonal, position.y + diagonal)
          .lineTo(position.x + diagonal, position.y - diagonal)
          .stroke(stroke)
      }
      return
    }

    const vector =
      entity.field.type === 'uniformGravity' ? entity.field.acceleration : entity.field.strength
    const magnitude = Math.hypot(vector.x, vector.y)
    if (magnitude <= 1e-12) return
    const direction = { x: vector.x / magnitude, y: vector.y / magnitude }
    const length = Math.min(72, 28 + 7 * Math.log10(1 + magnitude)) / pixelsPerMeter
    const start = {
      x: position.x - (direction.x * length) / 2,
      y: position.y - (direction.y * length) / 2,
    }
    const end = {
      x: position.x + (direction.x * length) / 2,
      y: position.y + (direction.y * length) / 2,
    }
    const headLength = 8 / pixelsPerMeter
    const normal = { x: -direction.y, y: direction.x }
    const stroke = { color, alpha: 1, width: 2.2 / pixelsPerMeter }
    this.content.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke(stroke)
    this.content
      .moveTo(end.x, end.y)
      .lineTo(
        end.x - direction.x * headLength + normal.x * headLength * 0.55,
        end.y - direction.y * headLength + normal.y * headLength * 0.55,
      )
      .moveTo(end.x, end.y)
      .lineTo(
        end.x - direction.x * headLength - normal.x * headLength * 0.55,
        end.y - direction.y * headLength - normal.y * headLength * 0.55,
      )
      .stroke(stroke)
  }

  private drawBooleanFields(state: PixiRenderState, results: ResolvedBooleanResult[]): void {
    const lineWidth = 1.25 / state.camera.pixelsPerMeter
    for (const result of results) {
      const node = findBooleanNode(state.scene.rootItems, result.nodeId)
      if (!result.valid || result.kind !== 'field' || !node?.visible) {
        continue
      }
      const color =
        result.fieldType === 'uniformGravity'
          ? colors.fieldGravity
          : result.fieldType === 'uniformElectric'
            ? colors.fieldElectric
            : colors.fieldMagnetic
      for (const region of result.regions) {
        appendBooleanGeometry(
          this.content,
          region.geometry,
          { color, alpha: 0.12 },
          { color, alpha: 0.72, width: lineWidth },
        )
      }
    }
  }

  private drawBooleanBodies(
    state: PixiRenderState,
    results: ResolvedBooleanResult[],
    transforms: ReadonlyMap<EntityId, { position: Vec2; angleRad: number }>,
  ): void {
    const lineWidth = 1.5 / state.camera.pixelsPerMeter
    for (const result of results) {
      if (!findBooleanNode(state.scene.rootItems, result.nodeId)?.visible) continue
      if (!result.valid) {
        for (const outline of result.sourceOutlines) {
          appendBooleanGeometry(this.content, outline, null, {
            color: colors.booleanInvalid,
            alpha: 0.72,
            width: lineWidth,
          })
        }
        continue
      }
      if (result.kind !== 'body') continue
      const transform = transforms.get(result.resultId) ?? {
        position: result.centerOfMass,
        angleRad: result.angleRad,
      }
      const geometry = transformBooleanBodyGeometry(result, transform.position, transform.angleRad)
      appendBooleanGeometry(
        this.content,
        geometry,
        { color: colors.booleanBodyFill, alpha: 0.78 },
        { color: colors.booleanBodyStroke, alpha: 0.96, width: lineWidth },
      )
      const center = transform.position
      this.content
        .circle(center.x, center.y, 2.2 / state.camera.pixelsPerMeter)
        .fill({ color: 0xffffff, alpha: 0.85 })
      if (result.chargeC !== 0) {
        const markRadius = 6 / state.camera.pixelsPerMeter
        this.content.moveTo(center.x - markRadius, center.y).lineTo(center.x + markRadius, center.y)
        if (result.chargeC > 0) {
          this.content
            .moveTo(center.x, center.y - markRadius)
            .lineTo(center.x, center.y + markRadius)
        }
        this.content.stroke({ color: 0xffffff, alpha: 0.95, width: lineWidth })
      }
    }
  }

  private drawBooleanOverlays(
    state: PixiRenderState,
    results: ResolvedBooleanResult[],
    transforms: ReadonlyMap<EntityId, { position: Vec2; angleRad: number }>,
  ): void {
    if (state.showOverlays === false) return
    const selected = new Set(state.selectedIds)
    const lineWidth = 2 / state.camera.pixelsPerMeter
    for (const result of results) {
      if (!selected.has(result.resultId)) continue
      const geometry =
        result.valid && result.kind === 'body'
          ? (() => {
              const transform = transforms.get(result.resultId)
              return transformBooleanBodyGeometry(result, transform?.position, transform?.angleRad)
            })()
          : result.valid
            ? result.geometry
            : result.sourceOutlines.reduce<BooleanMultiPolygon>(
                (combined, outline) => [...combined, ...outline],
                [],
              )
      appendBooleanGeometry(this.overlays, geometry, null, {
        color: result.valid ? colors.selection : colors.booleanInvalid,
        alpha: 1,
        width: lineWidth,
      })
    }
  }

  private drawGrounds(
    entities: SceneEntity[],
    network: GroundPathNetwork,
    pixelsPerMeter: number,
    entityId: EntityId,
  ): void {
    const lineWidth = 3 / pixelsPerMeter

    const ground = network.groundPaths.get(entityId)
    if (ground) {
      appendResolvedGroundPath(this.content, ground.path)
      this.content.stroke({ color: colors.ground, alpha: 0.95, width: lineWidth })
      return
    }
    const joint = network.jointPaths.get(entityId)
    if (joint?.path && joint.joint.id !== AUTO_JOINT_PREVIEW_ID) {
      appendResolvedGroundPath(this.content, joint.path)
      this.content.stroke({ color: colors.ground, alpha: 0.95, width: lineWidth })
      return
    }
    const entity = entities.find(
      (candidate): candidate is Extract<SceneEntity, { kind: 'ground' }> =>
        candidate.id === entityId && candidate.kind === 'ground',
    )
    if (!entity) return
    appendGroundPath(this.content, entity.geometry)
    this.content.stroke({ color: colors.groundJointInvalid, alpha: 0.72, width: lineWidth })
  }

  private drawGroundJoints(
    state: PixiRenderState,
    entities: SceneEntity[],
    network: GroundPathNetwork,
    previewJointId: EntityId | null,
  ): void {
    this.groundJoints.clear()
    const pixelsPerMeter = state.camera.pixelsPerMeter
    const lineWidth = 1.5 / pixelsPerMeter
    const endpointRadius = 4 / pixelsPerMeter
    const jointRadius = 5 / pixelsPerMeter

    if (state.activeTool === 'groundJoint') {
      for (const entity of entities) {
        if (
          entity.kind !== 'ground' ||
          entity.locked ||
          isTreeItemEffectivelyLocked(state.scene.rootItems, entity.id)
        )
          continue
        for (const endpoint of ['start', 'end'] as const) {
          const resolved = resolveGroundEndpoint(entities, { groundId: entity.id, endpoint })
          if (!resolved) continue
          this.groundJoints
            .circle(resolved.position.x, resolved.position.y, endpointRadius)
            .fill({ color: colors.groundJoint, alpha: 0.16 })
            .stroke({ color: colors.groundJoint, alpha: 0.8, width: lineWidth })
        }
      }
    }

    if (state.groundJointStart) {
      const pending = resolveGroundEndpoint(entities, state.groundJointStart)
      if (pending) {
        this.groundJoints
          .circle(pending.position.x, pending.position.y, endpointRadius * 1.8)
          .stroke({ color: colors.connector, alpha: 1, width: lineWidth * 1.8 })
      }
    }

    if (state.groundJointHover) {
      const hover = resolveGroundEndpoint(entities, state.groundJointHover)
      const previewIssue = previewJointId ? network.jointPaths.get(previewJointId)?.issue : null
      if (hover) {
        const color = previewIssue ? colors.groundJointInvalid : colors.connector
        this.groundJoints
          .circle(hover.position.x, hover.position.y, endpointRadius * 2)
          .fill({ color, alpha: 0.2 })
          .stroke({ color, alpha: 1, width: lineWidth * 2 })
      }
    }

    if (state.pendingGroundEndpoint) {
      const pending = resolveGroundEndpoint(entities, state.pendingGroundEndpoint)
      if (pending) {
        this.groundJoints
          .circle(pending.position.x, pending.position.y, endpointRadius * 2)
          .fill({ color: colors.connector, alpha: 0.2 })
          .stroke({ color: colors.connector, alpha: 1, width: lineWidth * 2 })
      }
    }

    const previewPath = previewJointId ? network.jointPaths.get(previewJointId)?.path : null
    if (previewPath) {
      appendResolvedGroundPath(this.groundJoints, previewPath)
      this.groundJoints.stroke({
        color: colors.connector,
        alpha: 0.9,
        width: 3 / pixelsPerMeter,
      })
      const arrowLength = 14 / pixelsPerMeter
      const arrowHeadLength = 5 / pixelsPerMeter
      const arrowPosition = previewPath.pointAt(previewPath.length / 2)
      const arrowTangent = previewPath.tangentAt(previewPath.length / 2)
      const arrowNormal = { x: -arrowTangent.y, y: arrowTangent.x }
      const arrowStart = {
        x: arrowPosition.x - arrowTangent.x * arrowLength * 0.5,
        y: arrowPosition.y - arrowTangent.y * arrowLength * 0.5,
      }
      const arrowEnd = {
        x: arrowPosition.x + arrowTangent.x * arrowLength * 0.5,
        y: arrowPosition.y + arrowTangent.y * arrowLength * 0.5,
      }
      this.groundJoints
        .moveTo(arrowStart.x, arrowStart.y)
        .lineTo(arrowEnd.x, arrowEnd.y)
        .lineTo(
          arrowEnd.x - arrowTangent.x * arrowHeadLength + arrowNormal.x * arrowHeadLength * 0.6,
          arrowEnd.y - arrowTangent.y * arrowHeadLength + arrowNormal.y * arrowHeadLength * 0.6,
        )
        .moveTo(arrowEnd.x, arrowEnd.y)
        .lineTo(
          arrowEnd.x - arrowTangent.x * arrowHeadLength - arrowNormal.x * arrowHeadLength * 0.6,
          arrowEnd.y - arrowTangent.y * arrowHeadLength - arrowNormal.y * arrowHeadLength * 0.6,
        )
        .stroke({ color: colors.connector, alpha: 1, width: lineWidth * 1.5 })
    }

    for (const entity of entities) {
      if (entity.kind !== 'groundJoint') continue
      const resolved = resolveGroundJoint(entities, entity)
      const issue = network.jointPaths.get(entity.id)?.issue ?? resolved.issue
      const color = issue ? colors.groundJointInvalid : colors.groundJoint

      if (resolved.a && resolved.b && issue) {
        this.groundJoints
          .moveTo(resolved.a.position.x, resolved.a.position.y)
          .lineTo(resolved.b.position.x, resolved.b.position.y)
          .stroke({ color, alpha: 0.72, width: lineWidth })
      }

      const positions = [resolved.a?.position, resolved.b?.position].filter(
        (position): position is Vec2 => Boolean(position),
      )
      if (!resolved.position) {
        for (const position of positions) {
          this.groundJoints
            .circle(position.x, position.y, jointRadius)
            .stroke({ color: colors.groundJointInvalid, alpha: 1, width: lineWidth * 1.5 })
        }
        continue
      }

      const { x, y } = resolved.position
      this.groundJoints
        .poly(
          [x, y - jointRadius, x + jointRadius, y, x, y + jointRadius, x - jointRadius, y],
          true,
        )
        .fill({ color, alpha: issue ? 0.42 : 0.92 })
        .stroke({ color, alpha: 1, width: lineWidth })

      if (issue) {
        this.groundJoints
          .moveTo(x - jointRadius * 0.55, y - jointRadius * 0.55)
          .lineTo(x + jointRadius * 0.55, y + jointRadius * 0.55)
          .moveTo(x + jointRadius * 0.55, y - jointRadius * 0.55)
          .lineTo(x - jointRadius * 0.55, y + jointRadius * 0.55)
          .stroke({ color: 0xffffff, alpha: 0.9, width: lineWidth })
      }
    }
  }

  private drawConnectors(
    entities: SceneEntity[],
    groundPathNetwork: GroundPathNetwork,
    pixelsPerMeter: number,
    runtimeConnectors: Record<EntityId, RuntimeConnectorState>,
    booleanBodyTransforms: ReadonlyMap<EntityId, { position: Vec2; angleRad: number }>,
    entityId: EntityId,
  ): void {
    const lineWidth = 2 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'connector' || entity.id !== entityId) continue
      const runtimePoints = runtimeConnectors[entity.id]?.points
      if (runtimePoints && runtimePoints.length >= 2) {
        if (entity.connector.type === 'spring') {
          const start = runtimePoints[0]!
          const end = runtimePoints[runtimePoints.length - 1]!
          this.drawSpring(start, end, lineWidth)
          this.drawSpringEndBars(entity, start, end, lineWidth)
          continue
        }
        this.content.moveTo(runtimePoints[0]!.x, runtimePoints[0]!.y)
        for (const point of runtimePoints.slice(1)) this.content.lineTo(point.x, point.y)
        this.content.stroke({
          color: colors.connector,
          alpha: entity.connector.type === 'rod' ? 1 : 0.9,
          width: Math.max(lineWidth, entity.radiusM * 2),
        })
        continue
      }
      const start = resolveConnectorEndpoint(
        entities,
        entity.a,
        groundPathNetwork,
        booleanBodyTransforms,
      )
      const end = resolveConnectorEndpoint(
        entities,
        entity.b,
        groundPathNetwork,
        booleanBodyTransforms,
      )
      if (!start || !end) continue
      if (entity.connector.type === 'spring') {
        this.drawSpring(start, end, lineWidth)
        this.drawSpringEndBars(entity, start, end, lineWidth)
      } else {
        this.content
          .moveTo(start.x, start.y)
          .lineTo(end.x, end.y)
          .stroke({
            color: colors.connector,
            alpha: entity.connector.type === 'rod' ? 1 : 0.85,
            width: entity.connector.type === 'rod' ? lineWidth * 1.8 : lineWidth,
          })
      }
    }
  }

  private drawSpring(start: Vec2, end: Vec2, lineWidth: number): void {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length <= Number.EPSILON) return
    const normal = { x: -dy / length, y: dx / length }
    const turns = 12
    const amplitude = Math.min(0.12, length / 10)
    this.content.moveTo(start.x, start.y)
    for (let index = 1; index < turns; index += 1) {
      const ratio = index / turns
      const offset = (index % 2 === 0 ? -1 : 1) * amplitude
      this.content.lineTo(
        start.x + dx * ratio + normal.x * offset,
        start.y + dy * ratio + normal.y * offset,
      )
    }
    this.content.lineTo(end.x, end.y).stroke({
      color: colors.connector,
      alpha: 0.95,
      width: lineWidth,
    })
  }

  private drawSpringEndBars(
    entity: ConnectorEntity,
    start: Vec2,
    end: Vec2,
    lineWidth: number,
  ): void {
    for (const [endpoint, definition] of [
      ['start', entity.a],
      ['end', entity.b],
    ] as const) {
      if (definition.type !== 'free') continue
      const bar = createSpringEndBar(start, end, endpoint, entity.radiusM)
      this.content
        .moveTo(bar.start.x, bar.start.y)
        .lineTo(bar.end.x, bar.end.y)
        .stroke({ color: colors.connector, alpha: 1, width: lineWidth * 1.6 })
    }
  }

  private drawMotionGuides(state: PixiRenderState): void {
    this.motionGuides.clear()
    const trajectoryIds = new Set(state.motionGuides?.trajectoryIds ?? state.selectedIds)
    const velocityIds = new Set(state.motionGuides?.velocityIds ?? state.selectedIds)
    const forceIds = new Set(state.motionGuides?.forceIds ?? state.selectedIds)
    const entityIds = new Set([...trajectoryIds, ...velocityIds, ...forceIds])
    const pixelsPerMeter = state.camera.pixelsPerMeter

    for (const entityId of entityIds) {
      const trajectory = state.runtimeTrajectories[entityId]
      if (trajectoryIds.has(entityId) && trajectory && trajectory.length > 1) {
        const first = trajectory[0]
        if (first) {
          this.motionGuides.moveTo(first.x, first.y)
          for (const point of trajectory.slice(1)) this.motionGuides.lineTo(point.x, point.y)
          this.motionGuides.stroke({
            color: state.motionGuides?.trajectoryColors?.[entityId] ?? colors.trajectory,
            alpha: 0.68,
            width: 1.6 / pixelsPerMeter,
          })
        }
      }

      const runtime = state.runtimeBodies[entityId]
      if (!runtime) continue
      if (velocityIds.has(entityId)) {
        this.drawVectorArrow(
          runtime.position,
          runtime.linearVelocity,
          0.28,
          3,
          colors.velocity,
          pixelsPerMeter,
        )
      }
      if (forceIds.has(entityId)) {
        this.drawVectorArrow(
          runtime.position,
          runtime.netForce,
          0.18,
          3,
          colors.force,
          pixelsPerMeter,
        )
      }
    }
  }

  private drawVectorArrow(
    start: Vec2,
    vector: Vec2,
    scale: number,
    maximumLength: number,
    color: number,
    pixelsPerMeter: number,
  ): void {
    const magnitude = Math.hypot(vector.x, vector.y)
    if (magnitude <= 1e-9) return
    const length = Math.min(maximumLength, magnitude * scale)
    const direction = { x: vector.x / magnitude, y: vector.y / magnitude }
    const end = { x: start.x + direction.x * length, y: start.y + direction.y * length }
    const headLength = Math.min(length * 0.35, 8 / pixelsPerMeter)
    const headWidth = headLength * 0.55
    const normal = { x: -direction.y, y: direction.x }
    const stroke = { color, alpha: 0.95, width: 2 / pixelsPerMeter }
    this.motionGuides.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke(stroke)
    this.motionGuides
      .moveTo(end.x, end.y)
      .lineTo(
        end.x - direction.x * headLength + normal.x * headWidth,
        end.y - direction.y * headLength + normal.y * headWidth,
      )
      .moveTo(end.x, end.y)
      .lineTo(
        end.x - direction.x * headLength - normal.x * headWidth,
        end.y - direction.y * headLength - normal.y * headWidth,
      )
      .stroke(stroke)
  }

  private drawBodies(entities: SceneEntity[], pixelsPerMeter: number): void {
    const lineWidth = 2 / pixelsPerMeter

    for (const entity of entities) {
      if (entity.kind !== 'body') continue
      const { position, angleRad } = entity.transform
      if (entity.shape.type === 'box') {
        this.content.poly(
          flattenPoints(
            rotatedRectangle(position, entity.shape.width, entity.shape.height, angleRad),
          ),
          true,
        )
      } else if (entity.shape.type === 'circle') {
        this.content.circle(position.x, position.y, entity.shape.radius)
      } else {
        this.content.poly(flattenPoints(sampleBezierBodyWorldPoints(entity)), true)
      }
      const bodyColor =
        entity.shape.type === 'circle'
          ? entity.shape.collisionEnabled
            ? colors.collisionOn
            : colors.collisionOff
          : colors.bodyFill
      this.content
        .fill({ color: bodyColor, alpha: 0.9 })
        .stroke({ color: colors.bodyStroke, alpha: 0.95, width: lineWidth })

      const radius = (() => {
        if (entity.shape.type === 'circle') return entity.shape.radius
        if (entity.shape.type === 'box')
          return Math.min(entity.shape.width, entity.shape.height) / 2
        return Math.max(
          0.001,
          ...entity.shape.nodes.map((node) => Math.hypot(node.anchor.x, node.anchor.y)),
        )
      })()
      const direction = rotateVector({ x: radius * 0.8, y: 0 }, angleRad)
      this.content
        .moveTo(position.x, position.y)
        .lineTo(position.x + direction.x, position.y + direction.y)
        .stroke({ color: 0xe9f5ff, alpha: 0.7, width: lineWidth })

      if (entity.chargeC !== 0) {
        const markRadius = Math.max(5 / pixelsPerMeter, radius * 0.3)
        this.content
          .moveTo(position.x - markRadius, position.y)
          .lineTo(position.x + markRadius, position.y)
        if (entity.chargeC > 0) {
          this.content
            .moveTo(position.x, position.y - markRadius)
            .lineTo(position.x, position.y + markRadius)
        }
        this.content.stroke({ color: 0xffffff, alpha: 0.95, width: lineWidth * 1.2 })
      }
    }
  }

  private drawOverlays(
    state: PixiRenderState,
    entities: SceneEntity[],
    groundPathNetwork: GroundPathNetwork,
    booleanBodyTransforms: ReadonlyMap<EntityId, { position: Vec2; angleRad: number }>,
  ): void {
    this.overlays.clear()
    if (state.showOverlays === false) return
    const lineWidth = 1.5 / state.camera.pixelsPerMeter
    const handleRadius = 5 / state.camera.pixelsPerMeter
    const selected = new Set(state.selectedIds)
    const overlayEntities = entities.map((entity) =>
      isTreeItemEffectivelyLocked(state.scene.rootItems, entity.id)
        ? { ...entity, locked: true }
        : entity,
    )
    const scaleBounds =
      state.activeTool === 'scale' && !state.runtimeLocked
        ? selectionTargetBounds(
            listEditingSelectionTargets(
              state.scene,
              overlayEntities,
              state.runtimeBodies,
              new Set(Object.keys(state.previewEntities)),
              new Set(state.selectedIds),
            ),
            state.selectedIds,
            true,
          )
        : null

    for (const entity of entities) {
      if (!selected.has(entity.id)) continue
      if (
        scaleBounds &&
        isScalableEntity(entity) &&
        !entity.locked &&
        !isTreeItemEffectivelyLocked(state.scene.rootItems, entity.id)
      ) {
        continue
      }
      if (entity.kind === 'groundJoint') {
        const resolved = resolveGroundJoint(entities, entity)
        const positions = resolved.position
          ? [resolved.position]
          : [resolved.a?.position, resolved.b?.position].filter((position): position is Vec2 =>
              Boolean(position),
            )
        for (const position of positions) {
          this.overlays
            .circle(position.x, position.y, handleRadius * 1.8)
            .stroke({ color: colors.selection, alpha: 1, width: lineWidth * 1.6 })
        }
        continue
      }
      if (entity.kind === 'connector') {
        const start = resolveConnectorEndpoint(
          entities,
          entity.a,
          groundPathNetwork,
          booleanBodyTransforms,
        )
        const end = resolveConnectorEndpoint(
          entities,
          entity.b,
          groundPathNetwork,
          booleanBodyTransforms,
        )
        if (!start || !end) continue
        this.overlays
          .moveTo(start.x, start.y)
          .lineTo(end.x, end.y)
          .stroke({ color: colors.selection, alpha: 0.75, width: lineWidth * 1.5 })
        for (const [index, point] of [start, end].entries()) {
          this.overlays
            .circle(point.x, point.y, handleRadius * 1.25)
            .fill({ color: colors.connector, alpha: 1 })
            .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
          const glyphHeight = 7 / state.camera.pixelsPerMeter
          const glyphWidth = 5 / state.camera.pixelsPerMeter
          const glyphX = point.x + handleRadius * 1.8
          const glyphY = point.y - glyphHeight / 2
          if (index === 0) {
            this.overlays
              .moveTo(glyphX, glyphY + glyphHeight)
              .lineTo(glyphX + glyphWidth / 2, glyphY)
              .lineTo(glyphX + glyphWidth, glyphY + glyphHeight)
              .moveTo(glyphX + glyphWidth * 0.25, glyphY + glyphHeight * 0.58)
              .lineTo(glyphX + glyphWidth * 0.75, glyphY + glyphHeight * 0.58)
              .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
          } else {
            this.overlays
              .moveTo(glyphX, glyphY)
              .lineTo(glyphX, glyphY + glyphHeight)
              .moveTo(glyphX, glyphY)
              .lineTo(glyphX + glyphWidth, glyphY + glyphHeight * 0.25)
              .lineTo(glyphX, glyphY + glyphHeight * 0.5)
              .lineTo(glyphX + glyphWidth, glyphY + glyphHeight * 0.75)
              .lineTo(glyphX, glyphY + glyphHeight)
              .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
          }
        }
        continue
      }
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

      if (entity.kind === 'ground' && entity.geometry.type === 'cubicBezier') {
        const { p0, p1, p2, p3 } = entity.geometry
        this.overlays
          .moveTo(p0.x, p0.y)
          .lineTo(p1.x, p1.y)
          .moveTo(p3.x, p3.y)
          .lineTo(p2.x, p2.y)
          .stroke({ color: colors.selection, alpha: 0.65, width: lineWidth })
        for (const [index, point] of [p0, p1, p2, p3].entries()) {
          this.overlays
            .circle(point.x, point.y, handleRadius * (index === 0 || index === 3 ? 1.15 : 0.9))
            .fill({
              color: index === 0 || index === 3 ? colors.selection : colors.connector,
              alpha: 1,
            })
        }
      }

      if (entity.kind === 'field' && entity.region.type === 'polygon') {
        for (const point of entity.region.points) {
          this.overlays
            .circle(point.x, point.y, handleRadius)
            .fill({ color: colors.selection, alpha: 1 })
        }
      }

      if (entity.kind === 'field' && entity.region.type === 'bezierPath') {
        for (const node of entity.region.nodes) {
          this.overlays
            .moveTo(node.anchor.x, node.anchor.y)
            .lineTo(node.inHandle.x, node.inHandle.y)
            .moveTo(node.anchor.x, node.anchor.y)
            .lineTo(node.outHandle.x, node.outHandle.y)
            .stroke({ color: colors.selection, alpha: 0.62, width: lineWidth })
          this.overlays
            .circle(node.anchor.x, node.anchor.y, handleRadius * 1.1)
            .fill({ color: colors.selection, alpha: 1 })
          for (const handle of [node.inHandle, node.outHandle]) {
            this.overlays
              .circle(handle.x, handle.y, handleRadius * 0.82)
              .fill({ color: colors.connector, alpha: 1 })
          }
        }
      }

      if (entity.kind === 'body' && entity.shape.type === 'bezierPath') {
        for (const node of worldBezierPathNodes(entity)) {
          this.overlays
            .moveTo(node.anchor.x, node.anchor.y)
            .lineTo(node.inHandle.x, node.inHandle.y)
            .moveTo(node.anchor.x, node.anchor.y)
            .lineTo(node.outHandle.x, node.outHandle.y)
            .stroke({ color: colors.selection, alpha: 0.62, width: lineWidth })
          this.overlays
            .circle(node.anchor.x, node.anchor.y, handleRadius * 1.1)
            .fill({ color: colors.selection, alpha: 1 })
          for (const handle of [node.inHandle, node.outHandle]) {
            this.overlays
              .circle(handle.x, handle.y, handleRadius * 0.82)
              .fill({ color: colors.connector, alpha: 1 })
          }
        }
      }
    }

    if (scaleBounds) {
      const geometry = createScaleHandleGeometry(scaleBounds, 5 / state.camera.pixelsPerMeter)
      const { minX, minY, maxX, maxY } = geometry.bounds
      const handleSize = 9 / state.camera.pixelsPerMeter
      const halfHandle = handleSize / 2
      const centerMark = 4 / state.camera.pixelsPerMeter
      this.overlays
        .rect(minX, minY, maxX - minX, maxY - minY)
        .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
        .moveTo(geometry.center.x - centerMark, geometry.center.y)
        .lineTo(geometry.center.x + centerMark, geometry.center.y)
        .moveTo(geometry.center.x, geometry.center.y - centerMark)
        .lineTo(geometry.center.x, geometry.center.y + centerMark)
        .stroke({ color: colors.selection, alpha: 0.8, width: lineWidth })
      for (const handle of geometry.handles) {
        this.overlays
          .rect(
            handle.position.x - halfHandle,
            handle.position.y - halfHandle,
            handleSize,
            handleSize,
          )
          .fill({ color: 0xffffff, alpha: 1 })
          .stroke({ color: colors.selection, alpha: 1, width: lineWidth })
      }
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

    if (state.connectorStartEndpoint) {
      const endpoint = resolveConnectorEndpoint(
        entities,
        state.connectorStartEndpoint,
        groundPathNetwork,
        booleanBodyTransforms,
      )
      if (endpoint) {
        this.overlays
          .circle(endpoint.x, endpoint.y, 10 / state.camera.pixelsPerMeter)
          .stroke({ color: colors.connector, alpha: 1, width: 2 * lineWidth })
      }
    }
  }
}
