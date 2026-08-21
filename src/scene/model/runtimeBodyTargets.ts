import { resolveBooleanScene } from './booleanGeometry'
import { findBooleanNode } from './booleanLayerGraph'
import type { BodyEntity, SceneDocument } from './types'

export function listRuntimeBodyTargets(scene: SceneDocument): BodyEntity[] {
  const booleanScene = resolveBooleanScene(scene)
  const sourceIds = new Set(booleanScene.roots.flatMap((result) => result.sourceEntityIds))
  const bodies = scene.entities.filter(
    (entity): entity is BodyEntity => entity.kind === 'body' && !sourceIds.has(entity.id),
  )
  for (const result of booleanScene.roots) {
    if (!result.valid || result.kind !== 'body') continue
    const node = findBooleanNode(scene.rootItems, result.nodeId)
    const firstRegion = result.materialRegions[0]
    bodies.push({
      id: result.resultId,
      kind: 'body',
      preset: 'block',
      name: node?.name ?? '布尔复合物体',
      visible: node?.visible ?? true,
      locked: node?.locked ?? false,
      simulationEnabled: result.simulationEnabled,
      shape: {
        type: 'box',
        width: Math.max(1e-6, result.bounds.max.x - result.bounds.min.x),
        height: Math.max(1e-6, result.bounds.max.y - result.bounds.min.y),
      },
      transform: { position: result.centerOfMass, angleRad: result.angleRad },
      massKg: result.massKg,
      chargeC: result.chargeC,
      material: firstRegion?.material ?? { friction: 0, restitution: 0 },
      initialVelocity: result.initialVelocity,
      initialAngularVelocityRad: result.initialAngularVelocityRad,
      rotationEnabled: result.rotationEnabled,
      continuousCollisionDetection: result.continuousCollisionDetection,
    })
  }

  return bodies
}
