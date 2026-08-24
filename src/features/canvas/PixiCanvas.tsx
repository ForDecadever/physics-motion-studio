import { useEffect, useRef, useState } from 'react'

import {
  panCamera,
  getVisibleSnapStep,
  screenToWorld,
  snapAngle,
  snapPoint,
  zoomCameraAtPoint,
  type Camera2D,
  type ViewportSize,
} from '../../editor/camera/viewport'
import {
  createAddEntityCommand,
  createReplaceEntitiesCommand,
} from '../../editor/commands/entityCommands'
import {
  createGroundWithAutoJoint,
  resolveGroundCreationStart,
} from '../../editor/ground/autoGroundJoint'
import {
  createScaleHandleGeometry,
  canScaleEntitiesByAxis,
  clampBodyLocalAnchor,
  createBodyCenterConnectorEndpoint,
  connectorEndpointTargetId,
  distance,
  dot,
  getEntityTransform,
  isScalableEntity,
  rectangleFromCorners,
  resolveConnectorEndpoint,
  rotateVector,
  scaleEntitiesAroundPivotByAxes,
  scaleEntitiesAroundPivot,
  scaleHandlePivot,
  snapBodyToSurfaces,
  snapBooleanBodyToSurfaces,
  subtract,
  type BodySnapSurfaceTarget,
  type ScaleHandle,
  worldToLocalAnchor,
  withEntityTransform,
} from '../../editor/geometry/entityGeometry'
import {
  findNearestGroundEndpoint,
  findTopBooleanResult,
  findTopEntity,
  snappedGroundPathRatio,
  type GridSnapStep,
} from '../../editor/geometry/hitTest'
import {
  listEditingSelectionTargets,
  selectionTargetBounds,
  selectionSourceEntityIds,
  selectionTargetsInsideBounds,
} from '../../editor/geometry/selectionTargets'
import { PixiSceneRenderer } from '../../renderer/pixi/PixiSceneRenderer'
import { analyzeBodyForces } from '../measurements/forceAnalysis'
import { forceColorNumber } from '../measurements/forcePresentation'
import {
  resolveBooleanBodyRenderTransform,
  resolveRenderedEntity,
} from '../../renderer/pixi/renderEntityState'
import {
  createArcGround,
  createBall,
  createBezierGround,
  createBezierBlock,
  createBlock,
  createElectricField,
  createForce,
  createGravityField,
  createGroundJoint,
  createLineGround,
  createMagneticField,
  createMarkerMeasurement,
  createParticleSource,
  createProtractorMeasurement,
  createRod,
  createRope,
  createRulerMeasurement,
  createSpring,
} from '../../scene/model/entityFactories'
import {
  createSmoothBezierPathNodes,
  moveBezierPathPoint,
  toggleBezierPathNodeMode,
  type BezierPathPointKey,
} from '../../scene/model/bezierPath'
import {
  analyzeBezierBodyPath,
  centerBezierPathNodes,
  worldBezierPathNodes,
} from '../../scene/model/bodyPath'
import {
  createCurvedBlockPresetNodes,
  createTriangleBlockNodes,
} from '../../scene/model/blockPresets'
import { sameGroundEndpoint } from '../../scene/model/groundEndpoints'
import { minimumFixedRopeLength } from '../../scene/model/connectorRules'
import {
  isTreeItemEffectivelyLocked,
  isTreeItemEffectivelyVisible,
} from '../../scene/model/booleanLayerGraph'
import {
  booleanBodyWorldToLocal,
  resolveBooleanScene,
  transformBooleanBodyGeometry,
} from '../../scene/model/booleanGeometry'
import {
  buildGroundPathNetwork,
  type GroundPathNetwork,
  type GroundJointPathIssue,
  type ResolvedGroundJointPath,
} from '../../scene/model/groundPath'
import type {
  BodyEntity,
  ConnectorEndpoint,
  ConnectorEntity,
  EntityId,
  FieldEntity,
  GroundEndpointRef,
  GroundEntity,
  MeasurementEntity,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'
import { useDocumentStore } from '../../stores/documentStore'
import {
  useEditorStore,
  type BlockToolShape,
  type BodyToolPreset,
  type EditorTool,
  type FieldToolPreset,
  type FieldRegionToolShape,
  type ParticleSourceToolShape,
} from '../../stores/editorStore'
import { isSimulationRuntimeLocked, useSimulationStore } from '../../stores/simulationStore'
import styles from './CanvasWorkspace.module.css'

type Interaction =
  | { type: 'idle' }
  | { type: 'pan'; startScreen: Vec2; startCamera: Camera2D }
  | { type: 'marquee'; startWorld: Vec2 }
  | { type: 'marker'; entity: MeasurementEntity }
  | { type: 'measurementMove'; startWorld: Vec2; originals: MeasurementEntity[] }
  | {
      type: 'move'
      startWorld: Vec2
      originals: SceneEntity[]
      anchorId: EntityId
      booleanResultIds: EntityId[]
    }
  | {
      type: 'booleanMove'
      startWorld: Vec2
      pivot: Vec2
      resultId: EntityId
      originals: SceneEntity[]
      selectedTargetIds: EntityId[]
    }
  | {
      type: 'rotate'
      pivot: Vec2
      startPointerAngle: number
      originals: SceneEntity[]
    }
  | {
      type: 'booleanRotate'
      pivot: Vec2
      startPointerAngle: number
      resultId: EntityId
      originals: SceneEntity[]
    }
  | {
      type: 'scale'
      pivot: Vec2
      startHandle: Vec2
      originals: SceneEntity[]
      targetIds: EntityId[]
      booleanResultIds: EntityId[]
      axis: ScaleHandle['axis']
      cursor: ScaleHandle['cursor']
    }
  | {
      type: 'booleanScale'
      pivot: Vec2
      startHandle: Vec2
      resultId: EntityId
      sourceIds: EntityId[]
      originals: SceneEntity[]
      axis: ScaleHandle['axis']
    }
  | {
      type: 'create'
      tool: 'ground' | 'body' | 'field' | 'particleSource'
      startWorld: Vec2
      draftId: EntityId
      layerId: string
      index: number
      groundShape: 'line' | 'arc' | 'cubicBezier'
      bodyPreset: BodyToolPreset
      blockShape: BlockToolShape
      triangleAngleDeg: number
      fieldPreset: FieldToolPreset
      fieldRegionShape: FieldRegionToolShape
      particleSourceShape: ParticleSourceToolShape
      pendingGroundEndpoint: GroundEndpointRef | null
    }
  | {
      type: 'groundPen'
      startWorld: Vec2
      draftId: EntityId
      layerId: string
      index: number
      pendingGroundEndpoint: GroundEndpointRef | null
    }
  | {
      type: 'fieldPen'
      points: Vec2[]
      draftId: EntityId
      layerId: string
      index: number
      fieldPreset: FieldToolPreset
    }
  | {
      type: 'bodyPen'
      points: Vec2[]
      draftId: EntityId
      layerId: string
      index: number
    }
  | {
      type: 'editBezierPoint'
      original: GroundEntity
      pointKey: 'p0' | 'p1' | 'p2' | 'p3'
    }
  | {
      type: 'editFieldPoint'
      original: FieldEntity
      pointIndex: number
    }
  | {
      type: 'editFieldPathPoint'
      original: FieldEntity
      nodeIndex: number
      pointKey: BezierPathPointKey
      startScreen: Vec2
      toggleCandidate: boolean
    }
  | {
      type: 'editBodyPathPoint'
      original: BodyEntity
      nodeIndex: number
      pointKey: BezierPathPointKey
      startScreen: Vec2
      toggleCandidate: boolean
    }
  | {
      type: 'editConnectorAnchor'
      original: ConnectorEntity
      endpointKey: 'a' | 'b'
    }

function localPoint(event: PointerEvent | WheelEvent, canvas: HTMLCanvasElement): Vec2 {
  const bounds = canvas.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

function toolCursor(tool: EditorTool): string {
  if (tool === 'hand') return 'grab'
  if (tool === 'zoom') return 'zoom-in'
  if (['rotate', 'ground', 'groundJoint', 'body', 'field', 'connector', 'force'].includes(tool))
    return 'crosshair'
  return 'default'
}

function scaleFactorFromPointer(
  pivot: Vec2,
  startHandle: Vec2,
  pointer: Vec2,
  snapStep: number | null,
): number {
  const handleVector = subtract(startHandle, pivot)
  const denominator = dot(handleVector, handleVector)
  if (denominator <= Number.EPSILON) return 1
  const rawFactor = dot(subtract(pointer, pivot), handleVector) / denominator
  if (!snapStep || snapStep <= 0) return rawFactor

  const desiredHandle = {
    x: pivot.x + handleVector.x * rawFactor,
    y: pivot.y + handleVector.y * rawFactor,
  }
  const candidates: number[] = []
  if (Math.abs(handleVector.x) > Number.EPSILON) {
    candidates.push((Math.round(desiredHandle.x / snapStep) * snapStep - pivot.x) / handleVector.x)
  }
  if (Math.abs(handleVector.y) > Number.EPSILON) {
    candidates.push((Math.round(desiredHandle.y / snapStep) * snapStep - pivot.y) / handleVector.y)
  }
  const valid = candidates.filter((factor) => Number.isFinite(factor) && factor > 0)
  if (valid.length === 0) return rawFactor
  return valid.reduce((nearest, factor) => {
    const nearestPoint = {
      x: pivot.x + handleVector.x * nearest,
      y: pivot.y + handleVector.y * nearest,
    }
    const candidatePoint = {
      x: pivot.x + handleVector.x * factor,
      y: pivot.y + handleVector.y * factor,
    }
    return distance(candidatePoint, pointer) < distance(nearestPoint, pointer) ? factor : nearest
  })
}

function endpointIsOccupied(
  entities: readonly SceneEntity[],
  endpoint: GroundEndpointRef,
): boolean {
  return entities.some(
    (entity) =>
      entity.kind === 'groundJoint' &&
      (sameGroundEndpoint(entity.a, endpoint) || sameGroundEndpoint(entity.b, endpoint)),
  )
}

function groundJointIssueMessage(issue: GroundJointPathIssue): string {
  if (issue === 'same-ground') return '地面连接点必须连接两块不同的地面。'
  if (issue === 'endpoint-conflict') return '至少一个端点已被其他地面连接点占用。'
  if (issue === 'angle-too-small') return '两块地面的方向几乎重合，无需创建连接线。'
  if (issue === 'linear-zero-length') return '反向地面的两个端点重合，无法生成直线连接。'
  if (issue === 'transition-invalid') return '无法生成有限、无自交的安全过渡，请重新选择端点。'
  if (issue === 'degenerate-tangent') return '端点切线无法确定，请检查零长度地面或控制点。'
  if (issue === 'missing-ground') return '找不到端点对应的地面，请重新选择。'
  return ''
}

function sameEndpointOrNull(
  first: GroundEndpointRef | null,
  second: GroundEndpointRef | null,
): boolean {
  return first === second || (!!first && !!second && sameGroundEndpoint(first, second))
}

function resolveGroundJointPath(
  entities: readonly SceneEntity[],
  joint: ReturnType<typeof createGroundJoint>,
): ResolvedGroundJointPath | null {
  return buildGroundPathNetwork([...entities, joint]).jointPaths.get(joint.id) ?? null
}

function connectorEndpointAt(
  entities: SceneEntity[],
  point: Vec2,
  toleranceM: number,
  fallbackEndpoint: ConnectorEndpoint | null,
  gridSnap: GridSnapStep | null = null,
): ConnectorEndpoint | null {
  const hit =
    findTopEntity(
      entities.filter((entity) => entity.kind === 'body'),
      point,
      toleranceM,
    ) ??
    findTopEntity(
      entities.filter((entity) => entity.kind === 'groundJoint'),
      point,
      toleranceM,
    ) ??
    findTopEntity(
      entities.filter((entity) => entity.kind === 'ground'),
      point,
      toleranceM,
    )
  if (!hit) return fallbackEndpoint
  if (hit.kind === 'body') {
    return createBodyCenterConnectorEndpoint(hit)
  }
  const network = buildGroundPathNetwork(entities)
  if (hit.kind === 'ground') {
    const path = network.groundPaths.get(hit.id)?.path
    if (!path) return fallbackEndpoint
    return {
      type: 'ground',
      groundId: hit.id,
      pathRatio: snappedGroundPathRatio(path, point, gridSnap),
    }
  }
  const path = network.jointPaths.get(hit.id)?.path
  if (!path) return fallbackEndpoint
  return {
    type: 'groundJoint',
    groundJointId: hit.id,
    pathRatio: snappedGroundPathRatio(path, point, gridSnap),
  }
}

function resolveCanvasConnectorEndpoint(
  entities: SceneEntity[],
  endpoint: ConnectorEndpoint,
  groundPathNetwork: GroundPathNetwork,
): Vec2 | null {
  if (endpoint.type === 'body') {
    const result = resolveBooleanScene(useDocumentStore.getState().scene).byResultId.get(
      endpoint.bodyId,
    )
    if (result?.valid && result.kind === 'body') {
      const runtime = useSimulationStore.getState().runtimeBodies[result.resultId]
      const position = runtime?.position ?? result.centerOfMass
      const angle = runtime?.angleRad ?? result.angleRad
      const cosine = Math.cos(angle)
      const sine = Math.sin(angle)
      return {
        x: position.x + endpoint.localAnchor.x * cosine - endpoint.localAnchor.y * sine,
        y: position.y + endpoint.localAnchor.x * sine + endpoint.localAnchor.y * cosine,
      }
    }
  }
  return resolveConnectorEndpoint(entities, endpoint, groundPathNetwork)
}

function moveConnectorEndpoint(
  connector: ConnectorEntity,
  endpointKey: 'a' | 'b',
  endpoint: ConnectorEndpoint,
  entities: SceneEntity[],
  point: Vec2,
  toleranceM: number,
  gridSnap: GridSnapStep | null,
): ConnectorEndpoint {
  if (connector.connector.type === 'spring') {
    const attached = connectorEndpointAt(entities, point, toleranceM, null, gridSnap)
    if (attached) return attached
    return { type: 'free', position: point }
  }
  if (endpoint.type === 'body') {
    const body = entities.find(
      (entity): entity is BodyEntity => entity.kind === 'body' && entity.id === endpoint.bodyId,
    )
    if (!body) return endpoint
    return {
      ...endpoint,
      localAnchor: clampBodyLocalAnchor(body, worldToLocalAnchor(body, point)),
    }
  }
  const network: GroundPathNetwork = buildGroundPathNetwork(entities)
  const path =
    endpoint.type === 'ground'
      ? network.groundPaths.get(endpoint.groundId)?.path
      : endpoint.type === 'groundJoint'
        ? network.jointPaths.get(endpoint.groundJointId)?.path
        : null
  if (!path) return endpoint
  const pathRatio = snappedGroundPathRatio(path, point, gridSnap)
  return endpoint.type === 'ground'
    ? { ...endpoint, pathRatio }
    : endpoint.type === 'groundJoint'
      ? { ...endpoint, pathRatio }
      : endpoint
}

function entityFactoryContextId(): string {
  // 实体工厂的首个参数仅保留调用签名，不再写入实体或表示图层归属。
  return 'scene-root'
}

function nextEntityIndex(kind: SceneEntity['kind']): number {
  return (
    useDocumentStore.getState().scene.entities.filter((entity) => entity.kind === kind).length + 1
  )
}

function getDraft(
  interaction: Extract<Interaction, { type: 'create' }>,
  end: Vec2,
  useDefaultSize = false,
): SceneEntity {
  const { startWorld: start, draftId, layerId, index, tool } = interaction

  if (tool === 'ground') {
    const resolvedEnd =
      useDefaultSize && distance(start, end) < 0.05 ? { x: start.x + 3, y: start.y } : end
    if (interaction.groundShape === 'line') {
      return { ...createLineGround(layerId, start, resolvedEnd, index), id: draftId }
    }

    const span = subtract(resolvedEnd, start)
    const length = Math.max(0.2, distance(start, resolvedEnd))
    const center = { x: (start.x + resolvedEnd.x) / 2, y: (start.y + resolvedEnd.y) / 2 }
    const directionAngle = Math.atan2(span.y, span.x)
    if (interaction.groundShape === 'arc') {
      return {
        ...createArcGround(
          layerId,
          center,
          length / 2,
          directionAngle + Math.PI,
          directionAngle + 2 * Math.PI,
          index,
        ),
        id: draftId,
      }
    }

    const normal = { x: span.y / length, y: -span.x / length }
    const depth = length * 0.28
    return {
      ...createBezierGround(
        layerId,
        start,
        {
          x: start.x + span.x / 3 + normal.x * depth,
          y: start.y + span.y / 3 + normal.y * depth,
        },
        {
          x: start.x + (span.x * 2) / 3 + normal.x * depth,
          y: start.y + (span.y * 2) / 3 + normal.y * depth,
        },
        resolvedEnd,
        index,
      ),
      id: draftId,
    }
  }

  if (tool === 'body') {
    if (interaction.bodyPreset === 'block') {
      if (interaction.blockShape === 'triangle') {
        const useDefault = useDefaultSize && distance(start, end) < 0.05
        const baseLength = useDefault ? 3 : end.x - start.x
        const riseDirection = useDefault || end.y >= start.y ? 1 : -1
        const body = createBezierBlock(
          layerId,
          createTriangleBlockNodes(start, baseLength, interaction.triangleAngleDeg, riseDirection),
          index,
        )
        if (body) return { ...body, id: draftId, name: `物块 ${index}` }
      }
      if (
        interaction.blockShape === 'quarterRamp' ||
        interaction.blockShape === 'semicircleCutout' ||
        interaction.blockShape === 'quarterCircleCutout'
      ) {
        const defaultEnd = { x: start.x + 0.5, y: start.y + 0.5 }
        const resolvedEnd = useDefaultSize && distance(start, end) < 0.05 ? defaultEnd : end
        const body = createBezierBlock(
          layerId,
          createCurvedBlockPresetNodes(
            interaction.blockShape,
            start,
            Math.max(0.2, Math.abs(resolvedEnd.x - start.x) * 2),
            Math.max(0.2, Math.abs(resolvedEnd.y - start.y) * 2),
          ),
          index,
        )
        if (body) return { ...body, id: draftId, name: `物块 ${index}` }
      }
      const rectangle =
        useDefaultSize && distance(start, end) < 0.05
          ? { center: start, width: 1, height: 1 }
          : rectangleFromCorners(start, end, 0.2)
      return {
        ...createBlock(layerId, rectangle.center, rectangle.width, rectangle.height, index),
        id: draftId,
      }
    }
    const radius =
      useDefaultSize && distance(start, end) < 0.05 ? 0.5 : Math.max(0.15, distance(start, end))
    return { ...createBall(layerId, start, radius, index), id: draftId }
  }

  if (tool === 'particleSource') {
    if (interaction.particleSourceShape === 'point') {
      return {
        ...createParticleSource(layerId, { type: 'point', position: start }, index),
        id: draftId,
      }
    }
    const resolvedEnd =
      useDefaultSize && distance(start, end) < 0.05 ? { x: start.x + 2, y: start.y } : end
    return {
      ...createParticleSource(layerId, { type: 'line', start, end: resolvedEnd }, index),
      id: draftId,
    }
  }

  const defaultEnd = { x: start.x + 4, y: start.y + 3 }
  const resolvedEnd = useDefaultSize && distance(start, end) < 0.05 ? defaultEnd : end
  const width = Math.max(0.2, Math.abs(resolvedEnd.x - start.x))
  const height = Math.max(0.2, Math.abs(resolvedEnd.y - start.y))
  const center = {
    x: (start.x + resolvedEnd.x) / 2,
    y: (start.y + resolvedEnd.y) / 2,
  }
  const field =
    interaction.fieldPreset === 'uniformElectric'
      ? createElectricField(layerId, center, width, height, index)
      : interaction.fieldPreset === 'uniformMagnetic'
        ? createMagneticField(layerId, center, width, height, index)
        : createGravityField(layerId, center, width, height, index)
  if (interaction.fieldRegionShape === 'infinite') {
    return { ...field, id: draftId, region: { type: 'infinite' } }
  }
  if (interaction.fieldRegionShape === 'circle') {
    const radius =
      useDefaultSize && distance(start, end) < 0.05 ? 2 : Math.max(0.1, distance(start, end))
    return {
      ...field,
      id: draftId,
      region: { type: 'circle', center: start, radius, startRad: 0, sweepRad: Math.PI * 2 },
    }
  }
  return { ...field, id: draftId }
}

function createGroundPenDraft(
  interaction: Extract<Interaction, { type: 'groundPen' }>,
  end: Vec2,
  useDefaultSize = false,
): GroundEntity {
  return getDraft(
    {
      type: 'create',
      tool: 'ground',
      startWorld: interaction.startWorld,
      draftId: interaction.draftId,
      layerId: interaction.layerId,
      index: interaction.index,
      groundShape: 'cubicBezier',
      bodyPreset: 'ball',
      blockShape: 'rectangle',
      triangleAngleDeg: 30,
      fieldPreset: 'uniformGravity',
      fieldRegionShape: 'rectangle',
      particleSourceShape: 'point',
      pendingGroundEndpoint: interaction.pendingGroundEndpoint,
    },
    end,
    useDefaultSize,
  ) as GroundEntity
}

function createFieldPenDraft(
  interaction: Extract<Interaction, { type: 'fieldPen' }>,
  points: Vec2[],
): FieldEntity {
  const safePoints = points.length >= 3 ? points : [...points, ...points.slice(-1)]
  const xValues = safePoints.map((point) => point.x)
  const yValues = safePoints.map((point) => point.y)
  const center = {
    x: (Math.min(...xValues) + Math.max(...xValues)) / 2,
    y: (Math.min(...yValues) + Math.max(...yValues)) / 2,
  }
  const width = Math.max(0.2, Math.max(...xValues) - Math.min(...xValues))
  const height = Math.max(0.2, Math.max(...yValues) - Math.min(...yValues))
  const field =
    interaction.fieldPreset === 'uniformElectric'
      ? createElectricField(interaction.layerId, center, width, height, interaction.index)
      : interaction.fieldPreset === 'uniformMagnetic'
        ? createMagneticField(interaction.layerId, center, width, height, interaction.index)
        : createGravityField(interaction.layerId, center, width, height, interaction.index)
  return {
    ...field,
    id: interaction.draftId,
    region: { type: 'bezierPath', nodes: createSmoothBezierPathNodes(safePoints) },
  }
}

function createBodyPenDraft(
  interaction: Extract<Interaction, { type: 'bodyPen' }>,
  points: Vec2[],
): BodyEntity {
  const safePoints = points.length >= 3 ? points : [...points, ...points.slice(-1)]
  const nodes = createSmoothBezierPathNodes(safePoints)
  const validBody = createBezierBlock(interaction.layerId, nodes, interaction.index)
  if (validBody) return { ...validBody, id: interaction.draftId }
  return {
    ...createBlock(interaction.layerId, { x: 0, y: 0 }, 1, 1, interaction.index),
    id: interaction.draftId,
    name: `钢笔物块 ${interaction.index}`,
    shape: { type: 'bezierPath', nodes },
    transform: { position: { x: 0, y: 0 }, angleRad: 0 },
  }
}

function finalizeBodyPen(
  interaction: Extract<Interaction, { type: 'bodyPen' }>,
): BodyEntity | null {
  return createBezierBlock(
    interaction.layerId,
    createSmoothBezierPathNodes(interaction.points),
    interaction.index,
  )
}

function withEditedBodyPath(
  original: BodyEntity,
  nodeIndex: number,
  pointKey: BezierPathPointKey,
  worldPoint: Vec2,
  independent: boolean,
): BodyEntity {
  if (original.shape.type !== 'bezierPath') return original
  const localPoint = rotateVector(
    subtract(worldPoint, original.transform.position),
    -original.transform.angleRad,
  )
  const movedNodes = moveBezierPathPoint(
    original.shape.nodes,
    nodeIndex,
    pointKey,
    localPoint,
    independent ? 'independent' : 'mirrored',
  )
  const centered = centerBezierPathNodes(movedNodes)
  const centerOffset = rotateVector(centered.center, original.transform.angleRad)
  return {
    ...original,
    shape: { type: 'bezierPath', nodes: centered.nodes },
    transform: {
      ...original.transform,
      position: {
        x: original.transform.position.x + centerOffset.x,
        y: original.transform.position.y + centerOffset.y,
      },
    },
  }
}

function withToggledBodyPathNode(original: BodyEntity, nodeIndex: number): BodyEntity {
  if (original.shape.type !== 'bezierPath') return original
  const centered = centerBezierPathNodes(toggleBezierPathNodeMode(original.shape.nodes, nodeIndex))
  const centerOffset = rotateVector(centered.center, original.transform.angleRad)
  return {
    ...original,
    shape: { type: 'bezierPath', nodes: centered.nodes },
    transform: {
      ...original.transform,
      position: {
        x: original.transform.position.x + centerOffset.x,
        y: original.transform.position.y + centerOffset.y,
      },
    },
  }
}

type EditableHandle =
  | { type: 'bezier'; entity: GroundEntity; pointKey: 'p0' | 'p1' | 'p2' | 'p3' }
  | { type: 'fieldPoint'; entity: FieldEntity; pointIndex: number }
  | {
      type: 'fieldPathPoint'
      entity: FieldEntity
      nodeIndex: number
      pointKey: BezierPathPointKey
    }
  | {
      type: 'bodyPathPoint'
      entity: BodyEntity
      nodeIndex: number
      pointKey: BezierPathPointKey
    }
  | { type: 'connectorAnchor'; entity: ConnectorEntity; endpointKey: 'a' | 'b' }

interface ScaleHandleHit {
  handle: ScaleHandle
  pivot: Vec2
}

function findScaleHandle(
  scene: ReturnType<typeof useDocumentStore.getState>['scene'],
  entities: SceneEntity[],
  selectedIds: EntityId[],
  point: Vec2,
  pixelsPerMeter: number,
): ScaleHandleHit | null {
  const editor = useEditorStore.getState()
  const bounds = selectionTargetBounds(
    listEditingSelectionTargets(
      scene,
      entities,
      useSimulationStore.getState().runtimeBodies,
      new Set(Object.keys(editor.previewEntities)),
      new Set(selectedIds),
    ),
    selectedIds,
    true,
  )
  if (!bounds) return null
  const targets = listEditingSelectionTargets(
    scene,
    entities,
    useSimulationStore.getState().runtimeBodies,
    new Set(Object.keys(editor.previewEntities)),
    new Set(selectedIds),
  ).filter((target) => selectedIds.includes(target.id) && target.scalable)
  const sourceIds = [...new Set(targets.flatMap((target) => target.sourceEntityIds))]
  const geometry = createScaleHandleGeometry(
    bounds,
    5 / pixelsPerMeter,
    canScaleEntitiesByAxis(scene.entities, sourceIds),
  )
  const tolerance = 9 / pixelsPerMeter
  const handle = geometry.handles.find(
    (candidate) => distance(candidate.position, point) <= tolerance,
  )
  if (!handle) return null
  return { handle, pivot: scaleHandlePivot(geometry, handle) }
}

function findEditableHandle(
  entities: SceneEntity[],
  selectedIds: EntityId[],
  point: Vec2,
  tolerance: number,
  preferAnchorOnTie = false,
): EditableHandle | null {
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index]
    if (!entity || !selectedIds.includes(entity.id)) continue
    if (entity.kind === 'ground' && entity.geometry.type === 'cubicBezier') {
      for (const pointKey of ['p0', 'p1', 'p2', 'p3'] as const) {
        if (distance(entity.geometry[pointKey], point) <= tolerance) {
          return { type: 'bezier', entity, pointKey }
        }
      }
    }
    if (entity.kind === 'field' && entity.region.type === 'polygon') {
      const pointIndex = entity.region.points.findIndex(
        (candidate) => distance(candidate, point) <= tolerance,
      )
      if (pointIndex >= 0) return { type: 'fieldPoint', entity, pointIndex }
    }
    if (entity.kind === 'field' && entity.region.type === 'bezierPath') {
      for (let nodeIndex = 0; nodeIndex < entity.region.nodes.length; nodeIndex += 1) {
        const node = entity.region.nodes[nodeIndex]
        if (!node) continue
        const pointKeys = preferAnchorOnTie
          ? (['anchor', 'inHandle', 'outHandle'] as const)
          : (['outHandle', 'inHandle', 'anchor'] as const)
        const pointKey = pointKeys
          .map((key) => ({ key, distance: distance(node[key], point) }))
          .filter((candidate) => candidate.distance <= tolerance)
          .sort((left, right) => left.distance - right.distance)[0]?.key
        if (pointKey) {
          return { type: 'fieldPathPoint', entity, nodeIndex, pointKey }
        }
      }
    }
    if (entity.kind === 'body' && entity.shape.type === 'bezierPath') {
      const nodes = worldBezierPathNodes(entity)
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        const node = nodes[nodeIndex]
        if (!node) continue
        const pointKeys = preferAnchorOnTie
          ? (['anchor', 'inHandle', 'outHandle'] as const)
          : (['outHandle', 'inHandle', 'anchor'] as const)
        const pointKey = pointKeys
          .map((key) => ({ key, distance: distance(node[key], point) }))
          .filter((candidate) => candidate.distance <= tolerance)
          .sort((left, right) => left.distance - right.distance)[0]?.key
        if (pointKey) {
          return { type: 'bodyPathPoint', entity, nodeIndex, pointKey }
        }
      }
    }
    if (entity.kind === 'connector') {
      for (const endpointKey of ['a', 'b'] as const) {
        const endpoint = resolveConnectorEndpoint(entities, entity[endpointKey])
        if (endpoint && distance(endpoint, point) <= tolerance) {
          return { type: 'connectorAnchor', entity, endpointKey }
        }
      }
    }
  }
  return null
}

function editableEntities(entities: SceneEntity[]): SceneEntity[] {
  const rootItems = useDocumentStore.getState().scene.rootItems
  const selectedIds = new Set(useEditorStore.getState().selectedIds)
  const booleanSourceIds = new Set(
    resolveBooleanScene(useDocumentStore.getState().scene).roots.flatMap(
      (result) => result.sourceEntityIds,
    ),
  )
  return entities
    .filter(
      (entity) =>
        isTreeItemEffectivelyVisible(rootItems, entity.id) &&
        (!booleanSourceIds.has(entity.id) || selectedIds.has(entity.id)),
    )
    .map((entity) =>
      isTreeItemEffectivelyLocked(rootItems, entity.id) ? { ...entity, locked: true } : entity,
    )
}

function movableEntitiesForSelection(selectedIds: readonly EntityId[]): SceneEntity[] {
  const scene = useDocumentStore.getState().scene
  const sourceIds = new Set(
    selectionSourceEntityIds(
      listEditingSelectionTargets(scene, scene.entities, {}, new Set(), new Set(selectedIds)),
      selectedIds,
    ),
  )
  return scene.entities.filter((entity) => sourceIds.has(entity.id) && getEntityTransform(entity))
}

function translateMeasurement(entity: MeasurementEntity, delta: Vec2): MeasurementEntity {
  const translate = (point: Vec2): Vec2 => ({ x: point.x + delta.x, y: point.y + delta.y })
  const measurement = entity.measurement
  if (measurement.type === 'marker') {
    return {
      ...entity,
      measurement: { ...measurement, points: measurement.points.map(translate) },
    }
  }
  if (measurement.type === 'ruler') {
    return {
      ...entity,
      measurement: { ...measurement, a: translate(measurement.a), b: translate(measurement.b) },
    }
  }
  return {
    ...entity,
    measurement: {
      ...measurement,
      a: translate(measurement.a),
      vertex: translate(measurement.vertex),
      b: translate(measurement.b),
    },
  }
}

function renderEntities(): SceneEntity[] {
  const { scene } = useDocumentStore.getState()
  const { previewEntities } = useEditorStore.getState()
  const { runtimeBodies } = useSimulationStore.getState()
  return scene.entities.map((entity) =>
    resolveRenderedEntity(entity, runtimeBodies, previewEntities),
  )
}

export function PixiCanvas({ size }: { size: ViewportSize }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<PixiSceneRenderer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef(size)
  const interactionRef = useRef<Interaction>({ type: 'idle' })
  const spacePressedRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scene = useDocumentStore((state) => state.scene)
  const activeTool = useEditorStore((state) => state.activeTool)
  const camera = useEditorStore((state) => state.camera)
  const gridVisible = useEditorStore((state) => state.gridVisible)
  const selectedIds = useEditorStore((state) => state.selectedIds)
  const previewEntities = useEditorStore((state) => state.previewEntities)
  const draftEntity = useEditorStore((state) => state.draftEntity)
  const marquee = useEditorStore((state) => state.marquee)
  const connectorStartEndpoint = useEditorStore((state) => state.connectorStartEndpoint)
  const groundJointStart = useEditorStore((state) => state.groundJointStart)
  const groundJointHover = useEditorStore((state) => state.groundJointHover)
  const pendingGroundEndpoint = useEditorStore((state) => state.pendingGroundEndpoint)
  const measurementPoints = useEditorStore((state) => state.measurementPoints)
  const forceProbe = useEditorStore((state) => state.forceProbe)
  const cursorWorld = useEditorStore((state) => state.cursorWorld)
  const runtimeBodies = useSimulationStore((state) => state.runtimeBodies)
  const runtimeConnectors = useSimulationStore((state) => state.runtimeConnectors)
  const runtimeTrajectories = useSimulationStore((state) => state.runtimeTrajectories)
  const runtimeParticleTrajectories = useSimulationStore(
    (state) => state.runtimeParticleTrajectories,
  )
  const runtimeParticleSources = useSimulationStore((state) => state.runtimeParticleSources)
  const simulationTime = useSimulationStore((state) => state.simulationTime)
  const runtimeLocked = useSimulationStore(isSimulationRuntimeLocked)

  useEffect(() => {
    const interaction = interactionRef.current
    const penStillActive =
      (interaction.type === 'groundPen' && activeTool === 'ground') ||
      (interaction.type === 'fieldPen' && activeTool === 'field') ||
      (interaction.type === 'bodyPen' && activeTool === 'body')
    if (interaction.type !== 'idle' && !penStillActive) {
      interactionRef.current = { type: 'idle' }
      useEditorStore.getState().clearPreview()
      useEditorStore.getState().setDraftEntity(null)
      useEditorStore.getState().setMarquee(null)
    }
  }, [activeTool])

  useEffect(() => {
    if (
      groundJointStart &&
      !scene.entities.some(
        (entity) => entity.kind === 'ground' && entity.id === groundJointStart.groundId,
      )
    ) {
      const editor = useEditorStore.getState()
      editor.setGroundJointStart(null)
      editor.setGroundJointHover(null)
      editor.setGroundJointMessage('第一个端点已不存在，请重新选择。')
    }
  }, [groundJointStart, scene.entities])

  useEffect(() => {
    if (!connectorStartEndpoint) return
    const targetId = connectorEndpointTargetId(connectorStartEndpoint)
    if (targetId && !scene.entities.some((entity) => entity.id === targetId)) {
      useEditorStore.getState().setConnectorStartEndpoint(null)
    }
  }, [connectorStartEndpoint, scene.entities])

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const renderer = new PixiSceneRenderer()

    void renderer
      .mount(host)
      .then((canvas) => {
        if (disposed) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer
        canvasRef.current = canvas
        setReady(true)
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : 'PixiJS 初始化失败。'
        setError(message)
      })

    return () => {
      disposed = true
      if (rendererRef.current === renderer) {
        rendererRef.current = null
        canvasRef.current = null
        renderer.destroy()
      }
    }
  }, [])

  useEffect(() => {
    if (!ready || !rendererRef.current) return
    rendererRef.current.resize(size)
    rendererRef.current.render({
      scene,
      camera,
      size,
      gridVisible,
      selectedIds,
      previewEntities,
      draftEntity,
      marquee,
      connectorStartEndpoint,
      activeTool,
      groundJointStart,
      groundJointHover,
      pendingGroundEndpoint,
      measurementPoints,
      measurementCursor: cursorWorld,
      forceProbe,
      forceAnalysis: forceProbe
        ? (analyzeBodyForces(
            scene,
            forceProbe.bodyId,
            runtimeBodies,
            simulationTime,
            runtimeConnectors,
          )?.map((entry) => ({ ...entry, color: forceColorNumber(entry) })) ?? undefined)
        : undefined,
      runtimeBodies,
      runtimeConnectors,
      runtimeTrajectories,
      particleTrajectories: runtimeParticleTrajectories,
      particleSources: runtimeParticleSources,
      simulationTime,
      runtimeLocked,
    })
    if (canvasRef.current && interactionRef.current.type === 'idle' && !spacePressedRef.current) {
      canvasRef.current.style.cursor = toolCursor(activeTool)
    }
  }, [
    activeTool,
    camera,
    connectorStartEndpoint,
    draftEntity,
    gridVisible,
    groundJointHover,
    groundJointStart,
    pendingGroundEndpoint,
    measurementPoints,
    cursorWorld,
    forceProbe,
    marquee,
    previewEntities,
    ready,
    runtimeBodies,
    runtimeConnectors,
    runtimeLocked,
    runtimeParticleTrajectories,
    runtimeParticleSources,
    runtimeTrajectories,
    scene,
    selectedIds,
    simulationTime,
    size,
  ])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas) return

    const updateCursor = (tool: EditorTool, interacting = false) => {
      if (interacting && interactionRef.current.type === 'pan') {
        canvas.style.cursor = 'grabbing'
      } else if (interacting && interactionRef.current.type === 'scale') {
        canvas.style.cursor = interactionRef.current.cursor
      } else if (tool === 'hand' || spacePressedRef.current) {
        canvas.style.cursor = 'grab'
      } else if (tool === 'zoom') {
        canvas.style.cursor = 'zoom-in'
      } else if (tool === 'rotate') {
        canvas.style.cursor = 'crosshair'
      } else if (
        [
          'ground',
          'groundJoint',
          'body',
          'field',
          'connector',
          'particleSource',
          'force',
          'marker',
          'ruler',
          'protractor',
          'forceMeter',
        ].includes(tool)
      ) {
        canvas.style.cursor = 'crosshair'
      } else {
        canvas.style.cursor = toolCursor(tool)
      }
    }

    const rawWorldPoint = (event: PointerEvent): Vec2 => {
      const editor = useEditorStore.getState()
      return screenToWorld(localPoint(event, canvas), editor.camera, sizeRef.current)
    }

    const resolvedWorldPoint = (event: PointerEvent): Vec2 => {
      const editor = useEditorStore.getState()
      const world = rawWorldPoint(event)
      const scene = useDocumentStore.getState().scene
      return editor.snapEnabled && !event.altKey
        ? snapPoint(
            world,
            getVisibleSnapStep(scene.settings.gridStep, editor.camera.pixelsPerMeter),
          )
        : world
    }

    const surfaceSnapTargets = (): BodySnapSurfaceTarget[] => {
      const editor = useEditorStore.getState()
      const document = useDocumentStore.getState().scene
      const ordinaryTargets = editableEntities(renderEntities()).filter(
        (candidate): candidate is GroundEntity | BodyEntity =>
          candidate.visible &&
          ((editor.wallSnapEnabled && candidate.kind === 'ground') ||
            (editor.blockSnapEnabled &&
              candidate.kind === 'body' &&
              candidate.shape.type !== 'circle')),
      )
      if (!editor.blockSnapEnabled) return ordinaryTargets

      const booleanScene = resolveBooleanScene(document)
      const runtimeBodies = useSimulationStore.getState().runtimeBodies
      const booleanTargets: BodySnapSurfaceTarget[] = booleanScene.roots.flatMap((result) => {
        if (
          !result.valid ||
          result.kind !== 'body' ||
          !isTreeItemEffectivelyVisible(document.rootItems, result.nodeId)
        ) {
          return []
        }
        const transform = resolveBooleanBodyRenderTransform(
          result,
          runtimeBodies[result.resultId],
          false,
        )
        return [
          {
            kind: 'booleanResult',
            id: result.resultId,
            visible: true,
            centerOfMass: transform.position,
            geometry: transformBooleanBodyGeometry(result, transform.position, transform.angleRad),
          },
        ]
      })
      const rootOrder = new Map(
        document.rootItems.map((item, index) => [
          item.kind === 'entity' ? item.entityId : item.resultId,
          index,
        ]),
      )
      const entityOrder = new Map(document.entities.map((entity, index) => [entity.id, index]))
      return [...ordinaryTargets, ...booleanTargets].sort((first, second) => {
        const rootDifference =
          (rootOrder.get(first.id) ?? Number.MAX_SAFE_INTEGER) -
          (rootOrder.get(second.id) ?? Number.MAX_SAFE_INTEGER)
        if (rootDifference !== 0) return rootDifference
        return (entityOrder.get(first.id) ?? -1) - (entityOrder.get(second.id) ?? -1)
      })
    }

    const applySurfaceSnap = (
      entity: SceneEntity,
      bypassSnap = false,
      excludedIds: ReadonlySet<EntityId> = new Set<EntityId>(),
    ): SceneEntity => {
      const editor = useEditorStore.getState()
      if (
        bypassSnap ||
        entity.kind !== 'body' ||
        (!editor.wallSnapEnabled && !editor.blockSnapEnabled)
      ) {
        return entity
      }
      const scene = useDocumentStore.getState().scene
      const booleanScene = resolveBooleanScene(scene)
      const expandedExcludedIds = new Set(excludedIds)
      for (const excludedId of excludedIds) {
        const rootResultId = booleanScene.rootResultIdBySourceId.get(excludedId)
        if (rootResultId) expandedExcludedIds.add(rootResultId)
      }
      return snapBodyToSurfaces(
        entity,
        surfaceSnapTargets(),
        12 / editor.camera.pixelsPerMeter,
        expandedExcludedIds,
      )
    }

    const startCreation = (
      tool: 'ground' | 'body' | 'field' | 'particleSource',
      world: Vec2,
      pendingGroundEndpoint: GroundEndpointRef | null = null,
      bypassSurfaceSnap = false,
    ) => {
      const layerId = entityFactoryContextId()
      const editor = useEditorStore.getState()
      editor.setPendingGroundEndpoint(tool === 'ground' ? pendingGroundEndpoint : null)
      const kind =
        tool === 'ground'
          ? 'ground'
          : tool === 'body'
            ? 'body'
            : tool === 'field'
              ? 'field'
              : 'particleSource'
      if (tool === 'ground' && editor.groundToolShape === 'cubicBezier') {
        const interaction: Extract<Interaction, { type: 'groundPen' }> = {
          type: 'groundPen',
          startWorld: world,
          draftId: crypto.randomUUID(),
          layerId,
          index: nextEntityIndex('ground'),
          pendingGroundEndpoint,
        }
        interactionRef.current = interaction
        editor.setDraftEntity(createGroundPenDraft(interaction, world))
        return
      }
      if (tool === 'field' && editor.fieldRegionToolShape === 'freeform') {
        const interaction: Extract<Interaction, { type: 'fieldPen' }> = {
          type: 'fieldPen',
          points: [world],
          draftId: crypto.randomUUID(),
          layerId,
          index: nextEntityIndex('field'),
          fieldPreset: editor.fieldToolPreset,
        }
        interactionRef.current = interaction
        editor.setDraftEntity(createFieldPenDraft(interaction, [world, world]))
        return
      }
      if (
        tool === 'body' &&
        editor.bodyToolPreset === 'block' &&
        editor.blockToolShape === 'freeform'
      ) {
        const interaction: Extract<Interaction, { type: 'bodyPen' }> = {
          type: 'bodyPen',
          points: [world],
          draftId: crypto.randomUUID(),
          layerId,
          index: nextEntityIndex('body'),
        }
        interactionRef.current = interaction
        editor.setDraftEntity(createBodyPenDraft(interaction, [world, world]))
        return
      }
      const interaction: Extract<Interaction, { type: 'create' }> = {
        type: 'create',
        tool,
        startWorld: world,
        draftId: crypto.randomUUID(),
        layerId,
        index: nextEntityIndex(kind),
        groundShape: editor.groundToolShape,
        bodyPreset: editor.bodyToolPreset,
        blockShape: editor.blockToolShape,
        triangleAngleDeg: editor.triangleAngleDeg,
        fieldPreset: editor.fieldToolPreset,
        fieldRegionShape: editor.fieldRegionToolShape,
        particleSourceShape: editor.particleSourceToolShape,
        pendingGroundEndpoint,
      }
      interactionRef.current = interaction
      useEditorStore
        .getState()
        .setDraftEntity(applySurfaceSnap(getDraft(interaction, world), bypassSurfaceSnap))
    }

    let pendingPointerMove: PointerEvent | null = null
    let pointerMoveFrame: number | null = null
    const discardPendingPointerMove = () => {
      if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame)
      pointerMoveFrame = null
      pendingPointerMove = null
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return
      // A hover move queued immediately before this press belongs to the old interaction.
      // Replaying it after pointerdown would create zero-distance drag commands or overwrite
      // the first ground-endpoint selection with a stale hover diagnostic.
      discardPendingPointerMove()
      canvas.focus()
      canvas.setPointerCapture(event.pointerId)
      const screen = localPoint(event, canvas)
      const editor = useEditorStore.getState()
      const rawWorld = rawWorldPoint(event)
      const world = resolvedWorldPoint(event)
      const tool = editor.activeTool

      if (event.button === 1 || tool === 'hand' || spacePressedRef.current) {
        interactionRef.current = { type: 'pan', startScreen: screen, startCamera: editor.camera }
        updateCursor(tool, true)
        event.preventDefault()
        return
      }

      if (tool === 'zoom') {
        editor.setCamera(
          zoomCameraAtPoint(editor.camera, screen, sizeRef.current, event.altKey ? 0.8 : 1.25),
        )
        return
      }

      const entities = editableEntities(renderEntities())
      const entityHit = findTopEntity(
        entities,
        rawWorld,
        8 / editor.camera.pixelsPerMeter,
        useSimulationStore.getState().runtimeConnectors,
      )
      const booleanHit =
        entityHit && editor.selectedIds.includes(entityHit.id)
          ? null
          : findTopBooleanResult(
              useDocumentStore.getState().scene,
              rawWorld,
              useSimulationStore.getState().runtimeBodies,
            )
      const hit = entityHit

      const measurementPoint = (): Vec2 => {
        if (event.altKey) return rawWorld
        const tolerance = 10 / editor.camera.pixelsPerMeter
        if (hit?.kind === 'body') {
          const position = hit.transform.position
          if (distance(rawWorld, position) <= tolerance) return position
        }
        if (booleanHit?.valid && booleanHit.kind === 'body') {
          const position =
            useSimulationStore.getState().runtimeBodies[booleanHit.resultId]?.position ??
            booleanHit.centerOfMass
          if (distance(rawWorld, position) <= tolerance) return position
        }
        return world
      }

      if (tool === 'marker' && event.button === 0) {
        const point = measurementPoint()
        const entity = createMarkerMeasurement(
          entityFactoryContextId(),
          [point, point],
          nextEntityIndex('measurement'),
        )
        interactionRef.current = { type: 'marker', entity }
        editor.setDraftEntity(entity)
        return
      }

      if ((tool === 'ruler' || tool === 'protractor') && event.button === 0) {
        const points = [...editor.measurementPoints, measurementPoint()]
        const required = tool === 'ruler' ? 2 : 3
        if (points.length < required) {
          editor.setMeasurementPoints(points)
          return
        }
        const entity =
          tool === 'ruler'
            ? createRulerMeasurement(
                entityFactoryContextId(),
                points[0]!,
                points[1]!,
                nextEntityIndex('measurement'),
              )
            : createProtractorMeasurement(
                entityFactoryContextId(),
                points[0]!,
                points[1]!,
                points[2]!,
                nextEntityIndex('measurement'),
              )
        const document = useDocumentStore.getState()
        document.executeCommand(createAddEntityCommand(document.scene, entity))
        editor.setMeasurementPoints([])
        editor.setSelectedIds([entity.id])
        return
      }

      if (tool === 'forceMeter' && event.button === 0) {
        const point = measurementPoint()
        const targetId =
          booleanHit?.valid && booleanHit.kind === 'body'
            ? booleanHit.resultId
            : hit?.kind === 'body'
              ? hit.id
              : null
        const localPoint =
          targetId && booleanHit?.valid && booleanHit.kind === 'body'
            ? booleanBodyWorldToLocal(
                booleanHit,
                point,
                useSimulationStore.getState().runtimeBodies[booleanHit.resultId]?.position,
                useSimulationStore.getState().runtimeBodies[booleanHit.resultId]?.angleRad,
              )
            : targetId && hit?.kind === 'body'
              ? worldToLocalAnchor(hit, point)
              : null
        editor.setForceProbe(targetId && localPoint ? { bodyId: targetId, localPoint } : null)
        if (!targetId) useSimulationStore.getState().addWarning('测力计需要点击一个物体。')
        return
      }

      if (tool === 'select' && hit?.kind === 'measurement' && event.button === 0) {
        const nextSelection = event.shiftKey
          ? editor.selectedIds.includes(hit.id)
            ? editor.selectedIds.filter((id) => id !== hit.id)
            : [...editor.selectedIds, hit.id]
          : editor.selectedIds.includes(hit.id)
            ? editor.selectedIds
            : [hit.id]
        editor.setSelectedIds(nextSelection)
        if (nextSelection.includes(hit.id)) {
          const originals = useDocumentStore
            .getState()
            .scene.entities.filter(
              (entity): entity is MeasurementEntity =>
                entity.kind === 'measurement' && nextSelection.includes(entity.id),
            )
          interactionRef.current = {
            type: 'measurementMove',
            startWorld: event.altKey ? rawWorld : world,
            originals,
          }
        }
        return
      }

      if (isSimulationRuntimeLocked(useSimulationStore.getState())) {
        const hitId = booleanHit?.resultId ?? hit?.id
        if (!hitId) {
          if (!event.shiftKey) editor.clearSelection()
        } else if (event.shiftKey) {
          editor.toggleSelectedId(hitId)
        } else {
          editor.setSelectedIds([hitId])
        }
        return
      }

      if (tool === 'scale') {
        const scaleHandle = findScaleHandle(
          useDocumentStore.getState().scene,
          entities,
          editor.selectedIds,
          rawWorld,
          editor.camera.pixelsPerMeter,
        )
        if (scaleHandle) {
          const selectionTargets = listEditingSelectionTargets(
            useDocumentStore.getState().scene,
            entities,
            useSimulationStore.getState().runtimeBodies,
            new Set(Object.keys(editor.previewEntities)),
            new Set(editor.selectedIds),
          ).filter((target) => editor.selectedIds.includes(target.id) && target.scalable)
          const booleanTargets = selectionTargets.filter(
            (target) => target.kind === 'booleanResult',
          )
          if (booleanTargets.length === 1 && selectionTargets.length === 1) {
            const booleanTarget = booleanTargets[0]!
            interactionRef.current = {
              type: 'booleanScale',
              pivot: scaleHandle.pivot,
              startHandle: scaleHandle.handle.position,
              resultId: booleanTarget.id,
              sourceIds: booleanTarget.sourceEntityIds,
              originals: useDocumentStore.getState().scene.entities,
              axis: scaleHandle.handle.axis,
            }
            updateCursor(tool, true)
            return
          }
          const targetIds = [
            ...new Set(selectionTargets.flatMap((target) => target.sourceEntityIds)),
          ]
          const ordinaryTargetIds = entities
            .filter(
              (entity) =>
                targetIds.includes(entity.id) &&
                entity.visible &&
                !entity.locked &&
                isScalableEntity(entity),
            )
            .map((entity) => entity.id)
          if (ordinaryTargetIds.length > 0) {
            interactionRef.current = {
              type: 'scale',
              pivot: scaleHandle.pivot,
              startHandle: scaleHandle.handle.position,
              originals: useDocumentStore.getState().scene.entities,
              targetIds: ordinaryTargetIds,
              booleanResultIds: booleanTargets.map((target) => target.id),
              axis: scaleHandle.handle.axis,
              cursor: scaleHandle.handle.cursor,
            }
            updateCursor(tool, true)
          }
          return
        }
      }

      const pending = interactionRef.current
      if (pending.type === 'groundPen' && tool === 'ground') {
        const entity = createGroundPenDraft(pending, world, true)
        const document = useDocumentStore.getState()
        document.executeCommand(
          createAddEntityCommand(
            document.scene,
            createGroundWithAutoJoint(document.scene, entity, pending.pendingGroundEndpoint),
          ),
        )
        editor.setDraftEntity(null)
        editor.setPendingGroundEndpoint(null)
        editor.setSelectedIds([entity.id])
        interactionRef.current = { type: 'idle' }
        return
      }
      if (pending.type === 'fieldPen' && tool === 'field') {
        const closeToStart =
          distance(world, pending.points[0] ?? world) <= 10 / editor.camera.pixelsPerMeter
        if (pending.points.length >= 3 && (closeToStart || event.detail >= 2)) {
          const entity = createFieldPenDraft(pending, pending.points)
          const document = useDocumentStore.getState()
          document.executeCommand(createAddEntityCommand(document.scene, entity))
          editor.setDraftEntity(null)
          editor.setSelectedIds([entity.id])
          interactionRef.current = { type: 'idle' }
        } else {
          const points = [...pending.points, world]
          interactionRef.current = { ...pending, points }
          editor.setDraftEntity(createFieldPenDraft(pending, [...points, world]))
        }
        return
      }
      if (pending.type === 'bodyPen' && tool === 'body') {
        const closeToStart =
          distance(world, pending.points[0] ?? world) <= 10 / editor.camera.pixelsPerMeter
        if (pending.points.length >= 3 && (closeToStart || event.detail >= 2)) {
          const entity = finalizeBodyPen(pending)
          if (entity) {
            const document = useDocumentStore.getState()
            document.executeCommand(createAddEntityCommand(document.scene, entity))
            editor.setDraftEntity(null)
            editor.setSelectedIds([entity.id])
            interactionRef.current = { type: 'idle' }
          } else {
            const analysis = analyzeBezierBodyPath(createSmoothBezierPathNodes(pending.points))
            useSimulationStore
              .getState()
              .addWarning(analysis.diagnostics.join('；') || '钢笔物块轮廓无效，尚未创建。')
            editor.setDraftEntity(createBodyPenDraft(pending, pending.points))
          }
        } else {
          const points = [...pending.points, world]
          interactionRef.current = { ...pending, points }
          editor.setDraftEntity(createBodyPenDraft(pending, [...points, world]))
        }
        return
      }

      if (tool === 'select') {
        const handle = findEditableHandle(
          entities,
          editor.selectedIds,
          rawWorld,
          9 / editor.camera.pixelsPerMeter,
          event.altKey,
        )
        if (handle?.type === 'bezier') {
          interactionRef.current = {
            type: 'editBezierPoint',
            original: handle.entity,
            pointKey: handle.pointKey,
          }
          return
        }
        if (handle?.type === 'fieldPoint') {
          interactionRef.current = {
            type: 'editFieldPoint',
            original: handle.entity,
            pointIndex: handle.pointIndex,
          }
          return
        }
        if (handle?.type === 'fieldPathPoint') {
          interactionRef.current = {
            type: 'editFieldPathPoint',
            original: handle.entity,
            nodeIndex: handle.nodeIndex,
            pointKey: handle.pointKey,
            startScreen: screen,
            toggleCandidate: event.altKey && handle.pointKey === 'anchor',
          }
          return
        }
        if (handle?.type === 'bodyPathPoint') {
          interactionRef.current = {
            type: 'editBodyPathPoint',
            original: handle.entity,
            nodeIndex: handle.nodeIndex,
            pointKey: handle.pointKey,
            startScreen: screen,
            toggleCandidate: event.altKey && handle.pointKey === 'anchor',
          }
          return
        }
        if (handle?.type === 'connectorAnchor') {
          interactionRef.current = {
            type: 'editConnectorAnchor',
            original: handle.entity,
            endpointKey: handle.endpointKey,
          }
          return
        }
      }

      if (tool === 'groundJoint') {
        const first = editor.groundJointStart
        const sceneEntities = useDocumentStore.getState().scene.entities
        const excludedGroundIds = first ? new Set([first.groundId]) : new Set<EntityId>()
        const endpointHit = findNearestGroundEndpoint(
          entities,
          rawWorld,
          9 / editor.camera.pixelsPerMeter,
          excludedGroundIds,
        )

        if (!endpointHit) {
          const sameGroundHit = first
            ? findNearestGroundEndpoint(entities, rawWorld, 9 / editor.camera.pixelsPerMeter)
            : null
          editor.setGroundJointMessage(
            sameGroundHit?.ground.id === first?.groundId
              ? '请选择另一块地面的端点，不能连接同一块地面。'
              : '请在地面端点 9 像素范围内点击。',
          )
          return
        }

        if (endpointIsOccupied(sceneEntities, endpointHit.reference)) {
          editor.setGroundJointMessage('这个端点已经有地面连接点，请选择其他端点。')
          return
        }

        if (!first) {
          editor.setGroundJointStart(endpointHit.reference)
          editor.setGroundJointHover(null)
          editor.setGroundJointMessage('已选择第一个端点，请选择另一块地面的端点。')
          editor.setSelectedIds([endpointHit.ground.id])
          return
        }

        const layerId = entityFactoryContextId()
        const joint = createGroundJoint(
          layerId,
          first,
          endpointHit.reference,
          nextEntityIndex('groundJoint'),
        )
        const resolvedPath = resolveGroundJointPath(sceneEntities, joint)
        if (!resolvedPath || resolvedPath.issue) {
          editor.setGroundJointMessage(
            resolvedPath?.issue
              ? groundJointIssueMessage(resolvedPath.issue)
              : '无法解析地面连接，请重新选择端点。',
          )
          return
        }

        const document = useDocumentStore.getState()
        document.executeCommand(createAddEntityCommand(document.scene, joint))
        editor.setSelectedIds([joint.id])
        editor.setGroundJointStart(null)
        editor.setGroundJointHover(null)
        editor.setGroundJointMessage('地面连接点已创建。')
        return
      }

      if (tool === 'force') {
        const document = useDocumentStore.getState()
        const booleanTarget = findTopBooleanResult(
          document.scene,
          rawWorld,
          useSimulationStore.getState().runtimeBodies,
        )
        const validBooleanTarget =
          booleanTarget?.valid && booleanTarget.kind === 'body' ? booleanTarget : null
        const ordinaryTarget = hit?.kind === 'body' ? hit : null
        if (!validBooleanTarget && !ordinaryTarget) {
          useSimulationStore.getState().addWarning('力工具需要点击普通物体或根布尔物体。')
          return
        }
        const bodyId = validBooleanTarget?.resultId ?? ordinaryTarget!.id
        const localAnchor = validBooleanTarget
          ? booleanBodyWorldToLocal(
              validBooleanTarget,
              rawWorld,
              useSimulationStore.getState().runtimeBodies[validBooleanTarget.resultId]?.position,
              useSimulationStore.getState().runtimeBodies[validBooleanTarget.resultId]?.angleRad,
            )
          : worldToLocalAnchor(ordinaryTarget!, rawWorld)
        const force = createForce(
          entityFactoryContextId(),
          bodyId,
          localAnchor,
          nextEntityIndex('force'),
        )
        document.executeCommand(createAddEntityCommand(document.scene, force))
        editor.setSelectedIds([force.id])
        return
      }

      if (tool === 'connector') {
        const gridSnap: GridSnapStep | null =
          editor.snapEnabled && !event.altKey
            ? {
                step: getVisibleSnapStep(
                  useDocumentStore.getState().scene.settings.gridStep,
                  editor.camera.pixelsPerMeter,
                ),
              }
            : null
        const booleanTarget = findTopBooleanResult(
          useDocumentStore.getState().scene,
          rawWorld,
          useSimulationStore.getState().runtimeBodies,
        )
        const runtimeBooleanBody =
          booleanTarget?.valid && booleanTarget.kind === 'body'
            ? useSimulationStore.getState().runtimeBodies[booleanTarget.resultId]
            : undefined
        const endpoint: ConnectorEndpoint | null =
          booleanTarget?.valid && booleanTarget.kind === 'body'
            ? {
                type: 'body',
                bodyId: booleanTarget.resultId,
                localAnchor: booleanBodyWorldToLocal(
                  booleanTarget,
                  rawWorld,
                  runtimeBooleanBody?.position,
                  runtimeBooleanBody?.angleRad,
                ),
              }
            : connectorEndpointAt(
                entities,
                rawWorld,
                9 / editor.camera.pixelsPerMeter,
                editor.connectorToolPreset === 'spring' ? { type: 'free', position: world } : null,
                gridSnap,
              )
        if (!endpoint) return
        if (!editor.connectorStartEndpoint) {
          editor.setConnectorStartEndpoint(endpoint)
          const targetId =
            endpoint.type === 'body'
              ? endpoint.bodyId
              : endpoint.type === 'ground'
                ? endpoint.groundId
                : endpoint.type === 'groundJoint'
                  ? endpoint.groundJointId
                  : null
          if (targetId) editor.setSelectedIds([targetId])
          return
        }
        const firstEndpoint = editor.connectorStartEndpoint
        const layerId = entityFactoryContextId()
        const network = buildGroundPathNetwork(entities)
        const firstPosition = resolveCanvasConnectorEndpoint(entities, firstEndpoint, network)
        const secondPosition = resolveCanvasConnectorEndpoint(entities, endpoint, network)
        if (firstPosition && secondPosition && layerId) {
          const length = distance(firstPosition, secondPosition)
          if (length < 0.001) {
            editor.setConnectorStartEndpoint(null)
            return
          }
          const index = nextEntityIndex('connector')
          const connector =
            editor.connectorToolPreset === 'rod'
              ? createRod(layerId, firstEndpoint, endpoint, length, index)
              : editor.connectorToolPreset === 'spring'
                ? createSpring(layerId, firstEndpoint, endpoint, length, index)
                : createRope(layerId, firstEndpoint, endpoint, length, index)
          useDocumentStore
            .getState()
            .executeCommand(createAddEntityCommand(useDocumentStore.getState().scene, connector))
          editor.setSelectedIds([connector.id])
          editor.setConnectorStartEndpoint(null)
        }
        return
      }

      if (tool === 'ground' || tool === 'body' || tool === 'field' || tool === 'particleSource') {
        if (tool === 'ground') {
          const start = resolveGroundCreationStart({
            entities,
            rawWorld,
            fallbackWorld: world,
            pixelsPerMeter: editor.camera.pixelsPerMeter,
            enabled: editor.autoGroundJointEnabled,
            bypassSnap: event.altKey,
          })
          startCreation(tool, start.startWorld, start.pendingEndpoint, event.altKey)
        } else {
          startCreation(tool, world, null, event.altKey)
        }
        return
      }

      if (tool === 'select') {
        if (booleanHit) {
          const resultId = booleanHit.resultId
          const nextSelection = event.shiftKey
            ? editor.selectedIds.includes(resultId)
              ? editor.selectedIds.filter((id) => id !== resultId)
              : [...editor.selectedIds, resultId]
            : editor.selectedIds.includes(resultId)
              ? editor.selectedIds
              : [resultId]
          editor.setSelectedIds(nextSelection)
          if (nextSelection.includes(resultId) && booleanHit.valid) {
            const pivot =
              booleanHit.kind === 'body'
                ? booleanHit.centerOfMass
                : {
                    x: (booleanHit.bounds.min.x + booleanHit.bounds.max.x) / 2,
                    y: (booleanHit.bounds.min.y + booleanHit.bounds.max.y) / 2,
                  }
            interactionRef.current = {
              type: 'booleanMove',
              startWorld: rawWorld,
              pivot,
              resultId,
              originals: movableEntitiesForSelection(nextSelection),
              selectedTargetIds: nextSelection,
            }
          }
          return
        }
        if (!hit) {
          if (!event.shiftKey) editor.clearSelection()
          interactionRef.current = { type: 'marquee', startWorld: rawWorld }
          editor.setMarquee({ start: rawWorld, end: rawWorld })
          return
        }

        let nextSelection = editor.selectedIds
        if (event.shiftKey) {
          nextSelection = editor.selectedIds.includes(hit.id)
            ? editor.selectedIds.filter((id) => id !== hit.id)
            : [...editor.selectedIds, hit.id]
        } else if (!editor.selectedIds.includes(hit.id)) {
          nextSelection = [hit.id]
        }
        editor.setSelectedIds(nextSelection)
        const originals = movableEntitiesForSelection(nextSelection)
        if (originals.length > 0 && nextSelection.includes(hit.id)) {
          const selectedTargets = listEditingSelectionTargets(
            useDocumentStore.getState().scene,
            useDocumentStore.getState().scene.entities,
            {},
            new Set(),
            new Set(nextSelection),
          )
          interactionRef.current = {
            type: 'move',
            startWorld: rawWorld,
            originals,
            anchorId: hit.id,
            booleanResultIds: selectedTargets
              .filter(
                (target) => target.kind === 'booleanResult' && nextSelection.includes(target.id),
              )
              .map((target) => target.id),
          }
        }
        return
      }

      if (tool === 'scale') {
        if (booleanHit) {
          editor.setSelectedIds([booleanHit.resultId])
          return
        }
        if (!hit) {
          if (!event.shiftKey) editor.clearSelection()
          return
        }
        const nextSelection = event.shiftKey
          ? editor.selectedIds.includes(hit.id)
            ? editor.selectedIds.filter((id) => id !== hit.id)
            : [...editor.selectedIds, hit.id]
          : editor.selectedIds.includes(hit.id)
            ? editor.selectedIds
            : [hit.id]
        editor.setSelectedIds(nextSelection)
        return
      }

      if (tool === 'rotate') {
        if (booleanHit) {
          editor.setSelectedIds([booleanHit.resultId])
          if (booleanHit.valid) {
            const pivot =
              booleanHit.kind === 'body'
                ? booleanHit.centerOfMass
                : {
                    x: (booleanHit.bounds.min.x + booleanHit.bounds.max.x) / 2,
                    y: (booleanHit.bounds.min.y + booleanHit.bounds.max.y) / 2,
                  }
            interactionRef.current = {
              type: 'booleanRotate',
              pivot,
              startPointerAngle: Math.atan2(rawWorld.y - pivot.y, rawWorld.x - pivot.x),
              resultId: booleanHit.resultId,
              originals: useDocumentStore
                .getState()
                .scene.entities.filter((entity) => booleanHit.sourceEntityIds.includes(entity.id)),
            }
          }
          return
        }
        if (!hit) return
        if (!editor.selectedIds.includes(hit.id)) editor.setSelectedIds([hit.id])
        const transform = getEntityTransform(hit)
        if (!transform) return
        const ids = editor.selectedIds.includes(hit.id) ? editor.selectedIds : [hit.id]
        interactionRef.current = {
          type: 'rotate',
          pivot: transform.position,
          startPointerAngle: Math.atan2(
            rawWorld.y - transform.position.y,
            rawWorld.x - transform.position.x,
          ),
          originals: entities.filter(
            (entity) => ids.includes(entity.id) && getEntityTransform(entity),
          ),
        }
      }
    }

    const processPointerMove = (event: PointerEvent) => {
      const screen = localPoint(event, canvas)
      const editor = useEditorStore.getState()
      const unsnappedWorld = screenToWorld(screen, editor.camera, sizeRef.current)
      editor.setCursorWorld(unsnappedWorld)
      const world = resolvedWorldPoint(event)
      const interaction = interactionRef.current

      if (editor.activeTool === 'scale' && interaction.type === 'idle') {
        const handle = findScaleHandle(
          useDocumentStore.getState().scene,
          editableEntities(renderEntities()),
          editor.selectedIds,
          unsnappedWorld,
          editor.camera.pixelsPerMeter,
        )
        canvas.style.cursor = handle?.handle.cursor ?? toolCursor(editor.activeTool)
      }

      if (editor.activeTool === 'groundJoint' && interaction.type === 'idle') {
        const entities = editableEntities(renderEntities())
        const sceneEntities = useDocumentStore.getState().scene.entities
        const hover =
          findNearestGroundEndpoint(entities, unsnappedWorld, 9 / editor.camera.pixelsPerMeter)
            ?.reference ?? null
        const hoverChanged = !sameEndpointOrNull(editor.groundJointHover, hover)
        if (hoverChanged) {
          editor.setGroundJointHover(hover)

          let message: string | null = null
          if (editor.groundJointStart) {
            if (!hover) {
              message = '已选择第一个端点，请选择另一块地面的端点。'
            } else {
              const firstGround = entities.find(
                (entity): entity is GroundEntity =>
                  entity.kind === 'ground' && entity.id === editor.groundJointStart?.groundId,
              )
              if (!firstGround) {
                editor.setGroundJointStart(null)
                editor.setGroundJointHover(null)
                message = '第一个端点已不存在，请重新选择。'
              } else {
                const preview = createGroundJoint('', editor.groundJointStart, hover, 0)
                const resolvedPath = resolveGroundJointPath(sceneEntities, preview)
                message = resolvedPath?.issue
                  ? groundJointIssueMessage(resolvedPath.issue)
                  : resolvedPath?.kind === 'direct'
                    ? '预览：将建立无形直接接缝。'
                    : resolvedPath?.kind === 'linear'
                      ? '预览：将生成端点间直线连接。'
                      : '预览：将生成平滑连接线。'
              }
            }
          } else if (hover) {
            message = endpointIsOccupied(sceneEntities, hover)
              ? '这个端点已经被地面连接点占用。'
              : '点击高亮端点作为第一个端点。'
          }
          if (editor.groundJointMessage !== message) editor.setGroundJointMessage(message)
        }
      }

      if (interaction.type === 'pan') {
        editor.setCamera(
          panCamera(interaction.startCamera, subtract(screen, interaction.startScreen)),
        )
      } else if (interaction.type === 'marquee') {
        editor.setMarquee({ start: interaction.startWorld, end: unsnappedWorld })
      } else if (interaction.type === 'marker') {
        if (interaction.entity.measurement.type !== 'marker') return
        const points = interaction.entity.measurement.points
        const last = points.at(-1)!
        if (distance(last, world) >= 2 / editor.camera.pixelsPerMeter && points.length < 4096) {
          interaction.entity = {
            ...interaction.entity,
            measurement: { ...interaction.entity.measurement, points: [...points, world] },
          }
          editor.setDraftEntity(interaction.entity)
        }
      } else if (interaction.type === 'measurementMove') {
        const delta = subtract(event.altKey ? unsnappedWorld : world, interaction.startWorld)
        editor.setPreviewEntities(
          interaction.originals.map((entity) => translateMeasurement(entity, delta)),
        )
      } else if (interaction.type === 'create') {
        editor.setDraftEntity(applySurfaceSnap(getDraft(interaction, world), event.altKey))
      } else if (interaction.type === 'groundPen') {
        editor.setDraftEntity(createGroundPenDraft(interaction, world))
      } else if (interaction.type === 'fieldPen') {
        editor.setDraftEntity(createFieldPenDraft(interaction, [...interaction.points, world]))
      } else if (interaction.type === 'bodyPen') {
        editor.setDraftEntity(createBodyPenDraft(interaction, [...interaction.points, world]))
      } else if (interaction.type === 'move') {
        const anchor = interaction.originals.find((entity) => entity.id === interaction.anchorId)
        const anchorTransform = anchor ? getEntityTransform(anchor) : null
        if (!anchorTransform) return
        let delta = subtract(unsnappedWorld, interaction.startWorld)
        if (editor.snapEnabled && !event.altKey) {
          const snappedAnchor = snapPoint(
            {
              x: anchorTransform.position.x + delta.x,
              y: anchorTransform.position.y + delta.y,
            },
            getVisibleSnapStep(
              useDocumentStore.getState().scene.settings.gridStep,
              editor.camera.pixelsPerMeter,
            ),
          )
          delta = subtract(snappedAnchor, anchorTransform.position)
        }
        let moved = interaction.originals.map((entity) => {
          const transform = getEntityTransform(entity)
          return transform
            ? withEntityTransform(entity, {
                ...transform,
                position: {
                  x: transform.position.x + delta.x,
                  y: transform.position.y + delta.y,
                },
              })
            : entity
        })
        if (!event.altKey && (editor.wallSnapEnabled || editor.blockSnapEnabled)) {
          const movedAnchor = moved.find(
            (entity): entity is Extract<SceneEntity, { kind: 'body' }> =>
              entity.id === interaction.anchorId && entity.kind === 'body',
          )
          if (movedAnchor) {
            const snappedAnchor = applySurfaceSnap(
              movedAnchor,
              false,
              new Set(interaction.originals.map((entity) => entity.id)),
            )
            if (snappedAnchor.kind === 'body') {
              const correction = subtract(
                snappedAnchor.transform.position,
                movedAnchor.transform.position,
              )
              moved = moved.map((entity) => {
                const transform = getEntityTransform(entity)
                return transform
                  ? withEntityTransform(entity, {
                      ...transform,
                      position: {
                        x: transform.position.x + correction.x,
                        y: transform.position.y + correction.y,
                      },
                    })
                  : entity
              })
            }
          }
        }
        editor.setPreviewEntities(moved)
      } else if (interaction.type === 'booleanMove') {
        let delta = subtract(unsnappedWorld, interaction.startWorld)
        if (editor.snapEnabled && !event.altKey) {
          const snappedPivot = snapPoint(
            { x: interaction.pivot.x + delta.x, y: interaction.pivot.y + delta.y },
            getVisibleSnapStep(
              useDocumentStore.getState().scene.settings.gridStep,
              editor.camera.pixelsPerMeter,
            ),
          )
          delta = subtract(snappedPivot, interaction.pivot)
        }
        let moved = interaction.originals.map((entity) => {
          const transform = getEntityTransform(entity)
          return transform
            ? withEntityTransform(entity, {
                ...transform,
                position: {
                  x: transform.position.x + delta.x,
                  y: transform.position.y + delta.y,
                },
              })
            : entity
        })
        if (!event.altKey && (editor.wallSnapEnabled || editor.blockSnapEnabled)) {
          const document = useDocumentStore.getState()
          const baseResult = resolveBooleanScene(document.scene).byResultId.get(
            interaction.resultId,
          )
          if (baseResult?.valid && baseResult.kind === 'body') {
            const movedCenter = {
              x: baseResult.centerOfMass.x + delta.x,
              y: baseResult.centerOfMass.y + delta.y,
            }
            const snappedCenter = snapBooleanBodyToSurfaces(
              {
                resultId: baseResult.resultId,
                centerOfMass: movedCenter,
                geometry: transformBooleanBodyGeometry(
                  baseResult,
                  movedCenter,
                  baseResult.angleRad,
                ),
              },
              surfaceSnapTargets(),
              12 / editor.camera.pixelsPerMeter,
              new Set([
                ...interaction.selectedTargetIds,
                ...interaction.originals.map((entity) => entity.id),
              ]),
            )
            const correction = subtract(snappedCenter, movedCenter)
            moved = moved.map((entity) => {
              const transform = getEntityTransform(entity)
              return transform
                ? withEntityTransform(entity, {
                    ...transform,
                    position: {
                      x: transform.position.x + correction.x,
                      y: transform.position.y + correction.y,
                    },
                  })
                : entity
            })
          }
        }
        editor.setPreviewEntities(moved)
      } else if (interaction.type === 'rotate') {
        const pointerAngle = Math.atan2(
          unsnappedWorld.y - interaction.pivot.y,
          unsnappedWorld.x - interaction.pivot.x,
        )
        const angleDelta = pointerAngle - interaction.startPointerAngle
        editor.setPreviewEntities(
          interaction.originals.map((entity) => {
            const transform = getEntityTransform(entity)
            if (!transform) return entity
            const angleRad =
              editor.snapEnabled && !event.altKey
                ? snapAngle(transform.angleRad + angleDelta)
                : transform.angleRad + angleDelta
            return withEntityTransform(entity, { ...transform, angleRad })
          }),
        )
      } else if (interaction.type === 'booleanRotate') {
        const pointerAngle = Math.atan2(
          unsnappedWorld.y - interaction.pivot.y,
          unsnappedWorld.x - interaction.pivot.x,
        )
        const rawDelta = pointerAngle - interaction.startPointerAngle
        const angleDelta = editor.snapEnabled && !event.altKey ? snapAngle(rawDelta) : rawDelta
        editor.setPreviewEntities(
          interaction.originals.map((entity) => {
            const transform = getEntityTransform(entity)
            if (!transform) return entity
            const offset = rotateVector(subtract(transform.position, interaction.pivot), angleDelta)
            return withEntityTransform(entity, {
              position: {
                x: interaction.pivot.x + offset.x,
                y: interaction.pivot.y + offset.y,
              },
              angleRad: transform.angleRad + angleDelta,
            })
          }),
        )
      } else if (interaction.type === 'scale') {
        const snapStep =
          editor.snapEnabled && !event.altKey
            ? getVisibleSnapStep(
                useDocumentStore.getState().scene.settings.gridStep,
                editor.camera.pixelsPerMeter,
              )
            : null
        const factor = scaleFactorFromPointer(
          interaction.pivot,
          interaction.startHandle,
          unsnappedWorld,
          snapStep,
        )
        const scaled =
          interaction.axis === 'uniform'
            ? (() => {
                const result = scaleEntitiesAroundPivot(
                  interaction.originals,
                  interaction.targetIds,
                  interaction.pivot,
                  factor,
                )
                return {
                  factors: { x: result.factor, y: result.factor },
                  replacements: result.replacements,
                }
              })()
            : scaleEntitiesAroundPivotByAxes(
                interaction.originals,
                interaction.targetIds,
                interaction.pivot,
                interaction.axis === 'x' ? { x: factor, y: 1 } : { x: 1, y: factor },
              )
        const resultIds = new Set(interaction.booleanResultIds)
        const externalConnectors = interaction.originals.flatMap((entity): SceneEntity[] => {
          if (entity.kind !== 'connector') return []
          const scaleEndpoint = (endpoint: ConnectorEndpoint): ConnectorEndpoint =>
            endpoint.type === 'body' && resultIds.has(endpoint.bodyId)
              ? {
                  ...endpoint,
                  localAnchor: {
                    x: endpoint.localAnchor.x * scaled.factors.x,
                    y: endpoint.localAnchor.y * scaled.factors.y,
                  },
                }
              : endpoint
          const a = scaleEndpoint(entity.a)
          const b = scaleEndpoint(entity.b)
          return a === entity.a && b === entity.b ? [] : [{ ...entity, a, b }]
        })
        editor.setPreviewEntities([...scaled.replacements, ...externalConnectors])
      } else if (interaction.type === 'booleanScale') {
        const snapStep =
          editor.snapEnabled && !event.altKey
            ? getVisibleSnapStep(
                useDocumentStore.getState().scene.settings.gridStep,
                editor.camera.pixelsPerMeter,
              )
            : null
        const requestedFactor = scaleFactorFromPointer(
          interaction.pivot,
          interaction.startHandle,
          unsnappedWorld,
          snapStep,
        )
        const scaled =
          interaction.axis === 'uniform'
            ? (() => {
                const result = scaleEntitiesAroundPivot(
                  interaction.originals,
                  interaction.sourceIds,
                  interaction.pivot,
                  requestedFactor,
                )
                return {
                  factors: { x: result.factor, y: result.factor },
                  replacements: result.replacements,
                }
              })()
            : scaleEntitiesAroundPivotByAxes(
                interaction.originals,
                interaction.sourceIds,
                interaction.pivot,
                interaction.axis === 'x'
                  ? { x: requestedFactor, y: 1 }
                  : { x: 1, y: requestedFactor },
              )
        const externalConnectors = interaction.originals.flatMap((entity): SceneEntity[] => {
          if (entity.kind !== 'connector') return []
          const scaleEndpoint = (endpoint: ConnectorEndpoint): ConnectorEndpoint =>
            endpoint.type === 'body' && endpoint.bodyId === interaction.resultId
              ? {
                  ...endpoint,
                  localAnchor: {
                    x: endpoint.localAnchor.x * scaled.factors.x,
                    y: endpoint.localAnchor.y * scaled.factors.y,
                  },
                }
              : endpoint
          const a = scaleEndpoint(entity.a)
          const b = scaleEndpoint(entity.b)
          return a === entity.a && b === entity.b ? [] : [{ ...entity, a, b }]
        })
        editor.setPreviewEntities([...scaled.replacements, ...externalConnectors])
      } else if (interaction.type === 'editBezierPoint') {
        const geometry = interaction.original.geometry
        if (geometry.type !== 'cubicBezier') return
        editor.setPreviewEntities([
          {
            ...interaction.original,
            geometry: { ...geometry, [interaction.pointKey]: world },
          },
        ])
      } else if (interaction.type === 'editFieldPoint') {
        const region = interaction.original.region
        if (region.type !== 'polygon') return
        editor.setPreviewEntities([
          {
            ...interaction.original,
            region: {
              ...region,
              points: region.points.map((point, index) =>
                index === interaction.pointIndex ? world : point,
              ),
            },
          },
        ])
      } else if (interaction.type === 'editFieldPathPoint') {
        if (interaction.toggleCandidate && distance(screen, interaction.startScreen) <= 3) return
        const region = interaction.original.region
        if (region.type !== 'bezierPath') return
        const nodes = moveBezierPathPoint(
          region.nodes,
          interaction.nodeIndex,
          interaction.pointKey,
          world,
          event.altKey ? 'independent' : 'mirrored',
        )
        editor.setPreviewEntities([{ ...interaction.original, region: { ...region, nodes } }])
      } else if (interaction.type === 'editBodyPathPoint') {
        if (interaction.toggleCandidate && distance(screen, interaction.startScreen) <= 3) return
        editor.setPreviewEntities([
          withEditedBodyPath(
            interaction.original,
            interaction.nodeIndex,
            interaction.pointKey,
            world,
            event.altKey,
          ),
        ])
      } else if (interaction.type === 'editConnectorAnchor') {
        const endpoint = interaction.original[interaction.endpointKey]
        const entities = editableEntities(renderEntities())
        const gridSnap: GridSnapStep | null =
          editor.snapEnabled && !event.altKey
            ? {
                step: getVisibleSnapStep(
                  useDocumentStore.getState().scene.settings.gridStep,
                  editor.camera.pixelsPerMeter,
                ),
              }
            : null
        const nextEndpoint = moveConnectorEndpoint(
          interaction.original,
          interaction.endpointKey,
          endpoint,
          entities,
          world,
          9 / editor.camera.pixelsPerMeter,
          gridSnap,
        )
        editor.setPreviewEntities([
          {
            ...interaction.original,
            [interaction.endpointKey]: nextEndpoint,
            collisionEnabled:
              interaction.original.connector.type === 'spring'
                ? false
                : interaction.original.collisionEnabled,
            massKg:
              interaction.original.connector.type === 'spring' ? 0 : interaction.original.massKg,
          },
        ])
      }
    }

    const flushPointerMove = () => {
      if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame)
      pointerMoveFrame = null
      const pending = pendingPointerMove
      pendingPointerMove = null
      if (pending) processPointerMove(pending)
    }
    const handlePointerMove = (event: PointerEvent) => {
      pendingPointerMove = event
      if (pointerMoveFrame !== null) return
      pointerMoveFrame = requestAnimationFrame(() => {
        pointerMoveFrame = null
        const pending = pendingPointerMove
        pendingPointerMove = null
        if (pending) processPointerMove(pending)
      })
    }

    const finishInteraction = (event: PointerEvent) => {
      flushPointerMove()
      const editor = useEditorStore.getState()
      const document = useDocumentStore.getState()
      const interaction = interactionRef.current
      const rawWorld = rawWorldPoint(event)
      const world = resolvedWorldPoint(event)

      if (interaction.type === 'marker') {
        const marker = interaction.entity
        if (marker.measurement.type === 'marker') {
          const points = marker.measurement.points
          const last = points.at(-1)!
          const finalPoints = distance(last, world) > 1e-9 ? [...points, world] : points
          const entity = {
            ...marker,
            measurement: { ...marker.measurement, points: finalPoints },
          } satisfies MeasurementEntity
          document.executeCommand(createAddEntityCommand(document.scene, entity))
          editor.setSelectedIds([entity.id])
        }
        editor.setDraftEntity(null)
        interactionRef.current = { type: 'idle' }
        updateCursor(editor.activeTool)
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }

      if (
        interaction.type === 'move' ||
        interaction.type === 'measurementMove' ||
        interaction.type === 'booleanMove' ||
        interaction.type === 'rotate' ||
        interaction.type === 'booleanRotate' ||
        interaction.type === 'scale' ||
        interaction.type === 'booleanScale' ||
        interaction.type === 'editBezierPoint' ||
        interaction.type === 'editFieldPoint' ||
        interaction.type === 'editFieldPathPoint' ||
        interaction.type === 'editBodyPathPoint' ||
        interaction.type === 'editConnectorAnchor'
      ) {
        const pointerScreen = localPoint(event, canvas)
        const toggledNode =
          (interaction.type === 'editFieldPathPoint' || interaction.type === 'editBodyPathPoint') &&
          interaction.toggleCandidate &&
          distance(pointerScreen, interaction.startScreen) <= 3
        let replacements = toggledNode
          ? interaction.type === 'editBodyPathPoint'
            ? [withToggledBodyPathNode(interaction.original, interaction.nodeIndex)]
            : interaction.original.region.type === 'bezierPath'
              ? [
                  {
                    ...interaction.original,
                    region: {
                      ...interaction.original.region,
                      nodes: toggleBezierPathNodeMode(
                        interaction.original.region.nodes,
                        interaction.nodeIndex,
                      ),
                    },
                  },
                ]
              : []
          : Object.values(editor.previewEntities)
        if (interaction.type === 'editBodyPathPoint') {
          const body = replacements.find(
            (candidate): candidate is BodyEntity =>
              candidate.id === interaction.original.id && candidate.kind === 'body',
          )
          if (body?.shape.type === 'bezierPath') {
            const analysis = analyzeBezierBodyPath(body.shape.nodes)
            if (!analysis.valid) {
              useSimulationStore
                .getState()
                .addWarning(`${analysis.diagnostics.join('；')} 已取消这次轮廓修改。`)
              replacements = []
            }
          }
        }
        if (replacements.length > 0) {
          if (interaction.type === 'editConnectorAnchor') {
            const connector = replacements.find(
              (candidate): candidate is ConnectorEntity =>
                candidate.kind === 'connector' && candidate.connector.type === 'rope',
            )
            if (connector) {
              const candidateEntities = document.scene.entities.map((candidate) =>
                candidate.id === connector.id ? connector : candidate,
              )
              const minimumLength = minimumFixedRopeLength(connector, (endpoint) =>
                resolveConnectorEndpoint(candidateEntities, endpoint),
              )
              if (
                minimumLength !== null &&
                connector.connector.type === 'rope' &&
                connector.connector.maxLength < minimumLength - 1e-6
              ) {
                useSimulationStore
                  .getState()
                  .addWarning(`两个固定端点至少需要 ${minimumLength.toPrecision(6)} m 的绳长。`)
                editor.clearPreview()
                interactionRef.current = { type: 'idle' }
                updateCursor(editor.activeTool)
                if (canvas.hasPointerCapture(event.pointerId)) {
                  canvas.releasePointerCapture(event.pointerId)
                }
                return
              }
            }
          }
          const label =
            interaction.type === 'measurementMove'
              ? '移动测量标注'
              : interaction.type === 'move'
                ? '移动实体'
                : interaction.type === 'booleanMove'
                  ? '整体移动布尔结果'
                  : interaction.type === 'rotate'
                    ? '旋转实体'
                    : interaction.type === 'booleanRotate'
                      ? '整体旋转布尔结果'
                      : interaction.type === 'scale'
                        ? '缩放实体'
                        : interaction.type === 'booleanScale'
                          ? '整体缩放布尔结果'
                          : interaction.type === 'editBezierPoint'
                            ? '拖动贝塞尔控制点'
                            : interaction.type === 'editFieldPoint'
                              ? '拖动场范围节点'
                              : interaction.type === 'editFieldPathPoint'
                                ? toggledNode
                                  ? '切换场范围贝塞尔节点模式'
                                  : '拖动场范围贝塞尔控制点'
                                : interaction.type === 'editBodyPathPoint'
                                  ? toggledNode
                                    ? '切换钢笔物块节点模式'
                                    : '拖动钢笔物块控制点'
                                  : '拖动连接锚点'
          document.executeCommand(
            createReplaceEntitiesCommand(
              document.scene,
              replacements,
              label,
              interaction.type === 'booleanMove' ||
                interaction.type === 'booleanRotate' ||
                interaction.type === 'booleanScale' ||
                (interaction.type === 'move' && interaction.booleanResultIds.length > 0)
                ? 'follow-result'
                : 'preserve-world',
            ),
          )
        }
        editor.clearPreview()
      } else if (interaction.type === 'marquee') {
        const rendered = editableEntities(renderEntities())
        const targets = listEditingSelectionTargets(
          document.scene,
          rendered,
          useSimulationStore.getState().runtimeBodies,
          new Set(Object.keys(editor.previewEntities)),
          new Set(),
          useSimulationStore.getState().runtimeConnectors,
        )
        const additions = selectionTargetsInsideBounds(targets, interaction.startWorld, rawWorld)
        editor.setSelectedIds(
          event.shiftKey
            ? [...new Set([...editor.selectedIds, ...additions.map((target) => target.id)])]
            : additions.map((target) => target.id),
        )
        editor.setMarquee(null)
      } else if (interaction.type === 'create') {
        const entity = applySurfaceSnap(getDraft(interaction, world, true), event.altKey)
        const additions =
          entity.kind === 'ground'
            ? createGroundWithAutoJoint(document.scene, entity, interaction.pendingGroundEndpoint)
            : [entity]
        document.executeCommand(createAddEntityCommand(document.scene, additions))
        editor.setDraftEntity(null)
        editor.setPendingGroundEndpoint(null)
        editor.setSelectedIds([entity.id])
      } else if (
        interaction.type === 'groundPen' ||
        interaction.type === 'fieldPen' ||
        interaction.type === 'bodyPen'
      ) {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
        return
      }

      interactionRef.current = { type: 'idle' }
      updateCursor(editor.activeTool)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }

    const cancelInteraction = () => {
      const editor = useEditorStore.getState()
      editor.clearPreview()
      editor.setDraftEntity(null)
      editor.setPendingGroundEndpoint(null)
      editor.setMarquee(null)
      editor.setMeasurementPoints([])
      if (editor.activeTool === 'groundJoint') {
        editor.setGroundJointStart(null)
        editor.setGroundJointHover(null)
        editor.setGroundJointMessage(null)
      }
      if (editor.activeTool === 'connector') editor.setConnectorStartEndpoint(null)
      interactionRef.current = { type: 'idle' }
      updateCursor(editor.activeTool)
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const editor = useEditorStore.getState()
      const factor = Math.exp(-event.deltaY * 0.0012)
      editor.setCamera(
        zoomCameraAtPoint(editor.camera, localPoint(event, canvas), sizeRef.current, factor),
      )
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat) {
        spacePressedRef.current = true
        updateCursor(useEditorStore.getState().activeTool)
        event.preventDefault()
      }
      if (event.key === 'Enter') {
        const interaction = interactionRef.current
        if (interaction.type === 'fieldPen' && interaction.points.length >= 3) {
          const editor = useEditorStore.getState()
          const document = useDocumentStore.getState()
          const entity = createFieldPenDraft(interaction, interaction.points)
          document.executeCommand(createAddEntityCommand(document.scene, entity))
          editor.setDraftEntity(null)
          editor.setSelectedIds([entity.id])
          interactionRef.current = { type: 'idle' }
          event.preventDefault()
        }
        if (interaction.type === 'bodyPen' && interaction.points.length >= 3) {
          const editor = useEditorStore.getState()
          const document = useDocumentStore.getState()
          const entity = finalizeBodyPen(interaction)
          if (entity) {
            document.executeCommand(createAddEntityCommand(document.scene, entity))
            editor.setDraftEntity(null)
            editor.setSelectedIds([entity.id])
            interactionRef.current = { type: 'idle' }
          } else {
            const analysis = analyzeBezierBodyPath(createSmoothBezierPathNodes(interaction.points))
            useSimulationStore
              .getState()
              .addWarning(analysis.diagnostics.join('；') || '钢笔物块轮廓无效，尚未创建。')
          }
          event.preventDefault()
        }
      }
      if (event.key === 'Escape') cancelInteraction()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePressedRef.current = false
        updateCursor(useEditorStore.getState().activeTool)
      }
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const editor = useEditorStore.getState()
      if (editor.activeTool === 'groundJoint') {
        editor.setGroundJointStart(null)
        editor.setGroundJointHover(null)
        editor.setGroundJointMessage(null)
      }
      if (editor.activeTool === 'connector') editor.setConnectorStartEndpoint(null)
    }

    updateCursor(useEditorStore.getState().activeTool)
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', finishInteraction)
    canvas.addEventListener('pointercancel', cancelInteraction)
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    canvas.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame)
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', finishInteraction)
      canvas.removeEventListener('pointercancel', cancelInteraction)
      canvas.removeEventListener('wheel', handleWheel)
      canvas.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [ready])

  return (
    <div className={styles.pixiHost} ref={hostRef} data-ready={ready}>
      {!ready && !error ? (
        <div className={styles.canvasLoading}>正在初始化 PixiJS 画布…</div>
      ) : null}
      {error ? <div className={styles.canvasError}>画布初始化失败：{error}</div> : null}
    </div>
  )
}
