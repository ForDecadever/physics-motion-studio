import type { ConnectorEndpoint, ConnectorEntity, Vec2 } from './types'

export const MIN_COLLIDING_ROPE_MASS_KG = 0.001

export function setConnectorCollisionEnabled(
  entity: ConnectorEntity,
  collisionEnabled: boolean,
): ConnectorEntity {
  if (entity.connector.type === 'spring') {
    return { ...entity, massKg: 0, collisionEnabled: false }
  }
  if (entity.connector.type !== 'rope') return { ...entity, collisionEnabled }
  return {
    ...entity,
    collisionEnabled,
    massKg: collisionEnabled ? Math.max(MIN_COLLIDING_ROPE_MASS_KG, entity.massKg) : 0,
  }
}

export function minimumFixedRopeLength(
  entity: ConnectorEntity,
  resolveEndpoint: (endpoint: ConnectorEndpoint) => Vec2 | null,
): number | null {
  if (entity.connector.type !== 'rope') return null
  const isFixed = (endpoint: ConnectorEndpoint) =>
    endpoint.type === 'world' || endpoint.type === 'ground' || endpoint.type === 'groundJoint'
  if (!isFixed(entity.a) || !isFixed(entity.b)) return null
  const first = resolveEndpoint(entity.a)
  const second = resolveEndpoint(entity.b)
  if (!first || !second) return null
  return Math.hypot(second.x - first.x, second.y - first.y)
}
