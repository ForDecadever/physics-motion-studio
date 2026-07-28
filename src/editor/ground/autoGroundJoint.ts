import { createGroundJoint } from '../../scene/model/entityFactories'
import { buildGroundPathNetwork } from '../../scene/model/groundPath'
import { findNearestUnoccupiedGroundEndpoint } from '../geometry/hitTest'
import type {
  GroundEndpointRef,
  GroundEntity,
  SceneDocument,
  SceneEntity,
  Vec2,
} from '../../scene/model/types'

export interface GroundCreationStart {
  startWorld: Vec2
  pendingEndpoint: GroundEndpointRef | null
}

export function resolveGroundCreationStart({
  entities,
  rawWorld,
  fallbackWorld,
  pixelsPerMeter,
  enabled,
  bypassSnap,
}: {
  entities: readonly SceneEntity[]
  rawWorld: Vec2
  fallbackWorld: Vec2
  pixelsPerMeter: number
  enabled: boolean
  bypassSnap: boolean
}): GroundCreationStart {
  if (!enabled || bypassSnap) {
    return { startWorld: fallbackWorld, pendingEndpoint: null }
  }

  const endpoint = findNearestUnoccupiedGroundEndpoint(entities, rawWorld, 10 / pixelsPerMeter)
  return endpoint
    ? { startWorld: endpoint.position, pendingEndpoint: endpoint.reference }
    : { startWorld: fallbackWorld, pendingEndpoint: null }
}

export function createGroundWithAutoJoint(
  scene: SceneDocument,
  ground: GroundEntity,
  pendingEndpoint: GroundEndpointRef | null,
): SceneEntity[] {
  if (!pendingEndpoint) return [ground]

  const joint = createGroundJoint(
    ground.layerId,
    pendingEndpoint,
    { groundId: ground.id, endpoint: 'start' },
    scene.entities.filter((entity) => entity.kind === 'groundJoint').length + 1,
  )
  const candidates = [...scene.entities, ground, joint]
  const resolvedPath = buildGroundPathNetwork(candidates).jointPaths.get(joint.id)
  return !resolvedPath || resolvedPath.issue ? [ground] : [ground, joint]
}
