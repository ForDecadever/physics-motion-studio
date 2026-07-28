import type {
  GroundEndpointKey,
  GroundEndpointRef,
  GroundEntity,
  GroundJointEntity,
  SceneEntity,
  Vec2,
} from './types'

export interface ResolvedGroundEndpoint {
  ground: GroundEntity
  endpoint: GroundEndpointKey
  position: Vec2
  inwardTangent: Vec2
}

export type GroundJointIssue =
  'missing-ground' | 'degenerate-tangent' | 'same-ground' | 'endpoint-conflict'

export interface ResolvedGroundJoint {
  a: ResolvedGroundEndpoint | null
  b: ResolvedGroundEndpoint | null
  position: Vec2 | null
  gapM: number
  tangentAlignment: number
  issue: GroundJointIssue | null
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scale(vector: Vec2, factor: number): Vec2 {
  return { x: vector.x * factor, y: vector.y * factor }
}

function normalize(vector: Vec2): Vec2 | null {
  const length = Math.hypot(vector.x, vector.y)
  return length > 1e-9 ? scale(vector, 1 / length) : null
}

function firstDirection(...candidates: Vec2[]): Vec2 | null {
  for (const candidate of candidates) {
    const direction = normalize(candidate)
    if (direction) return direction
  }
  return null
}

function naturalEndpoint(
  ground: GroundEntity,
  endpoint: GroundEndpointKey,
): { position: Vec2; tangent: Vec2 | null } {
  const geometry = ground.geometry
  if (geometry.type === 'line') {
    return {
      position: endpoint === 'start' ? geometry.start : geometry.end,
      tangent: normalize(subtract(geometry.end, geometry.start)),
    }
  }

  if (geometry.type === 'arc') {
    const angle = endpoint === 'start' ? geometry.startRad : geometry.endRad
    if (geometry.radius <= 1e-9 || Math.abs(geometry.endRad - geometry.startRad) <= 1e-9) {
      return {
        position: {
          x: geometry.center.x + Math.cos(angle) * geometry.radius,
          y: geometry.center.y + Math.sin(angle) * geometry.radius,
        },
        tangent: null,
      }
    }
    const direction = geometry.endRad >= geometry.startRad ? 1 : -1
    return {
      position: {
        x: geometry.center.x + Math.cos(angle) * geometry.radius,
        y: geometry.center.y + Math.sin(angle) * geometry.radius,
      },
      tangent: { x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction },
    }
  }

  if (endpoint === 'start') {
    return {
      position: geometry.p0,
      tangent: firstDirection(
        subtract(geometry.p1, geometry.p0),
        subtract(geometry.p2, geometry.p0),
        subtract(geometry.p3, geometry.p0),
      ),
    }
  }
  return {
    position: geometry.p3,
    tangent: firstDirection(
      subtract(geometry.p3, geometry.p2),
      subtract(geometry.p3, geometry.p1),
      subtract(geometry.p3, geometry.p0),
    ),
  }
}

function findGround(entities: readonly SceneEntity[], groundId: string): GroundEntity | null {
  return (
    entities.find(
      (entity): entity is GroundEntity => entity.kind === 'ground' && entity.id === groundId,
    ) ?? null
  )
}

export function resolveGroundEndpoint(
  entities: readonly SceneEntity[],
  reference: GroundEndpointRef,
): ResolvedGroundEndpoint | null {
  const ground = findGround(entities, reference.groundId)
  if (!ground) return null

  const resolved = naturalEndpoint(ground, reference.endpoint)
  if (!resolved.tangent) return null
  return {
    ground,
    endpoint: reference.endpoint,
    position: resolved.position,
    inwardTangent: reference.endpoint === 'start' ? resolved.tangent : scale(resolved.tangent, -1),
  }
}

export function resolveGroundJoint(
  entities: readonly SceneEntity[],
  joint: GroundJointEntity,
): ResolvedGroundJoint {
  const aGround = findGround(entities, joint.a.groundId)
  const bGround = findGround(entities, joint.b.groundId)
  const a = resolveGroundEndpoint(entities, joint.a)
  const b = resolveGroundEndpoint(entities, joint.b)
  if (!aGround || !bGround) {
    return {
      a,
      b,
      position: null,
      gapM: Infinity,
      tangentAlignment: -1,
      issue: 'missing-ground',
    }
  }
  if (!a || !b) {
    return {
      a,
      b,
      position: null,
      gapM: Infinity,
      tangentAlignment: -1,
      issue: 'degenerate-tangent',
    }
  }

  const gapM = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
  const position = {
    x: (a.position.x + b.position.x) / 2,
    y: (a.position.y + b.position.y) / 2,
  }
  const tangentAlignment = -(
    a.inwardTangent.x * b.inwardTangent.x +
    a.inwardTangent.y * b.inwardTangent.y
  )
  const issue =
    a.ground.id === b.ground.id
      ? 'same-ground'
      : entities.some(
            (entity) =>
              entity.kind === 'groundJoint' &&
              entity.id !== joint.id &&
              (sameGroundEndpoint(entity.a, joint.a) ||
                sameGroundEndpoint(entity.b, joint.a) ||
                sameGroundEndpoint(entity.a, joint.b) ||
                sameGroundEndpoint(entity.b, joint.b)),
          )
        ? 'endpoint-conflict'
        : null

  return { a, b, position, gapM, tangentAlignment, issue }
}

export function sameGroundEndpoint(a: GroundEndpointRef, b: GroundEndpointRef): boolean {
  return a.groundId === b.groundId && a.endpoint === b.endpoint
}
