import type { BooleanNode, BooleanOperation, SceneTreeItem } from './types'

export function createBooleanLayer(
  operation: BooleanOperation,
  name: string,
  operands: SceneTreeItem[] = [],
  inheritedFrom?: BooleanNode | null,
  createId: () => string = () => crypto.randomUUID(),
): BooleanNode {
  return {
    id: createId(),
    kind: 'boolean',
    name,
    visible: true,
    locked: false,
    operation,
    resultId: createId(),
    operands: operands.slice(0, 2),
    simulationEnabled: inheritedFrom?.simulationEnabled ?? true,
    rotationEnabled: inheritedFrom?.rotationEnabled ?? true,
    continuousCollisionDetection: inheritedFrom?.continuousCollisionDetection ?? false,
    massDistribution: { mode: 'source' },
    chargeDistribution: { mode: 'source' },
    fieldDistribution: { mode: 'source' },
    frictionDistribution: { mode: 'source' },
    restitutionDistribution: { mode: 'source' },
    initialVelocity: { mode: 'source' },
    initialAngularVelocity: { mode: 'source' },
  }
}

export function createEntityTreeItem(entityId: string): SceneTreeItem {
  return { kind: 'entity', entityId }
}
