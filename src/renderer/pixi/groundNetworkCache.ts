import { buildGroundPathNetwork, type GroundPathNetwork } from '../../scene/model/groundPath'
import type {
  EntityId,
  GroundEndpointRef,
  GroundEntity,
  GroundJointEntity,
  SceneEntity,
} from '../../scene/model/types'

export const AUTO_JOINT_PREVIEW_ID = '__auto-ground-joint-preview__'
export const MANUAL_JOINT_PREVIEW_ID = '__manual-ground-joint-preview__'

type GroundNetworkEntity = GroundEntity | GroundJointEntity

export interface GroundRenderNetwork {
  network: GroundPathNetwork
  previewJointId: EntityId | null
}

function sameEntityReferences(
  previous: readonly GroundNetworkEntity[],
  next: readonly GroundNetworkEntity[],
): boolean {
  return (
    previous.length === next.length && previous.every((entity, index) => entity === next[index])
  )
}

function endpointKey(endpoint: GroundEndpointRef | null): string | null {
  return endpoint ? `${endpoint.groundId}:${endpoint.endpoint}` : null
}

export class GroundRenderNetworkCache {
  private groundEntities: readonly GroundNetworkEntity[] = []
  private pendingKey: string | null = null
  private manualKey: string | null = null
  private cached: GroundRenderNetwork | null = null

  resolve(
    entities: readonly SceneEntity[],
    draftEntity: SceneEntity | null,
    pendingEndpoint: GroundEndpointRef | null,
    manualStart: GroundEndpointRef | null = null,
    manualHover: GroundEndpointRef | null = null,
  ): GroundRenderNetwork {
    const groundEntities = entities.filter(
      (entity): entity is GroundNetworkEntity =>
        entity.kind === 'ground' || entity.kind === 'groundJoint',
    )
    const nextPendingKey = endpointKey(pendingEndpoint)
    const nextManualKey =
      manualStart && manualHover ? `${endpointKey(manualStart)}>${endpointKey(manualHover)}` : null
    if (
      this.cached &&
      this.pendingKey === nextPendingKey &&
      this.manualKey === nextManualKey &&
      sameEntityReferences(this.groundEntities, groundEntities)
    ) {
      return this.cached
    }

    const draft =
      draftEntity?.kind === 'ground'
        ? groundEntities.find(
            (entity): entity is GroundEntity =>
              entity.kind === 'ground' && entity.id === draftEntity.id,
          )
        : null
    let result: GroundRenderNetwork
    if (pendingEndpoint && draft) {
      const previewJoint: GroundJointEntity = {
        id: AUTO_JOINT_PREVIEW_ID,
        name: '自动连接预览',
        kind: 'groundJoint',
        layerId: draft.layerId,
        visible: true,
        locked: true,
        simulationEnabled: false,
        a: pendingEndpoint,
        b: { groundId: draft.id, endpoint: 'start' },
        transition: { mode: 'auto', directionFlipped: false },
      }
      result = {
        network: buildGroundPathNetwork([...groundEntities, previewJoint]),
        previewJointId: previewJoint.id,
      }
    } else if (manualStart && manualHover) {
      const startGround = groundEntities.find(
        (entity): entity is GroundEntity =>
          entity.kind === 'ground' && entity.id === manualStart.groundId,
      )
      if (!startGround) {
        result = { network: buildGroundPathNetwork(groundEntities), previewJointId: null }
      } else {
        const previewJoint: GroundJointEntity = {
          id: MANUAL_JOINT_PREVIEW_ID,
          name: '手动连接预览',
          kind: 'groundJoint',
          layerId: startGround.layerId,
          visible: true,
          locked: true,
          simulationEnabled: false,
          a: manualStart,
          b: manualHover,
          transition: { mode: 'auto', directionFlipped: false },
        }
        result = {
          network: buildGroundPathNetwork([...groundEntities, previewJoint]),
          previewJointId: previewJoint.id,
        }
      }
    } else {
      result = { network: buildGroundPathNetwork(groundEntities), previewJointId: null }
    }

    this.groundEntities = groundEntities
    this.pendingKey = nextPendingKey
    this.manualKey = nextManualKey
    this.cached = result
    return result
  }
}
