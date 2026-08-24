import type { GroundCollisionPathPiece, GroundPathNetwork } from '../../scene/model/groundPath'
import type { GroundConveyor, Material2D, Vec2 } from '../../scene/model/types'

type Endpoint = 'start' | 'end'

interface PieceEndpoint {
  pieceId: string
  endpoint: Endpoint
}

export interface GroundCollisionChain {
  points: Vec2[]
  material: Material2D
  pieceIds: string[]
  conveyor: GroundConveyor
  conveyorSpeedAlongPointsMps: number
  closed: boolean
  startConnected: boolean
  endConnected: boolean
}

function endpointKey(reference: PieceEndpoint): string {
  return `${reference.pieceId}:${reference.endpoint}`
}

function opposite(endpoint: Endpoint): Endpoint {
  return endpoint === 'start' ? 'end' : 'start'
}

function sameMaterial(first: Material2D, second: Material2D): boolean {
  return first.friction === second.friction && first.restitution === second.restitution
}

const DISABLED_CONVEYOR: GroundConveyor = {
  enabled: false,
  direction: 'forward',
  speedMps: 1,
}

function conveyorForPiece(
  network: GroundPathNetwork,
  piece: GroundCollisionPathPiece,
): GroundConveyor {
  return network.groundPaths.get(piece.sourceGroundId)?.ground.conveyor ?? DISABLED_CONVEYOR
}

function pieceDirectionMatchesSourceGround(
  network: GroundPathNetwork,
  piece: GroundCollisionPathPiece,
): 1 | -1 {
  const segment = network.segments.find((candidate) =>
    candidate.collisionPieces.some((candidatePiece) => candidatePiece.id === piece.id),
  )
  if (!segment || segment.kind === 'ground' || !segment.jointId) return 1
  const joint = network.jointPaths.get(segment.jointId)?.joint
  if (!joint) return 1
  const reference = joint.a.groundId === piece.sourceGroundId ? joint.a : joint.b
  return reference.endpoint === 'end' ? 1 : -1
}

function sameChainProperties(
  network: GroundPathNetwork,
  first: GroundCollisionPathPiece,
  second: GroundCollisionPathPiece,
): boolean {
  if (!sameMaterial(first.material, second.material)) return false
  const firstConveyor = conveyorForPiece(network, first)
  const secondConveyor = conveyorForPiece(network, second)
  if (!firstConveyor.enabled && !secondConveyor.enabled) return true
  return (
    first.sourceGroundId === second.sourceGroundId &&
    firstConveyor.enabled === secondConveyor.enabled &&
    firstConveyor.direction === secondConveyor.direction &&
    firstConveyor.speedMps === secondConveyor.speedMps
  )
}

function samePoint(first: Vec2, second: Vec2): boolean {
  return Math.hypot(first.x - second.x, first.y - second.y) <= 1e-7
}

function orientedPoints(piece: GroundCollisionPathPiece, entry: Endpoint): Vec2[] {
  const points = piece.path.sample()
  return entry === 'start' ? points : [...points].reverse()
}

function withoutCollinearInteriorPoints(points: readonly Vec2[]): Vec2[] {
  if (points.length <= 2) return [...points]
  const result: Vec2[] = [points[0]!]
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = result.at(-1)!
    const current = points[index]!
    const next = points[index + 1]!
    const first = { x: current.x - previous.x, y: current.y - previous.y }
    const second = { x: next.x - current.x, y: next.y - current.y }
    const cross = Math.abs(first.x * second.y - first.y * second.x)
    const scale = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y)
    if (scale <= 1e-12 || cross > scale * 1e-7) result.push(current)
  }
  result.push(points.at(-1)!)
  return result
}

export function buildGroundCollisionChains(network: GroundPathNetwork): GroundCollisionChain[] {
  const pieces = new Map<string, GroundCollisionPathPiece>()
  const links = new Map<string, PieceEndpoint>()
  const boundaries = new Map<string, { start: PieceEndpoint; end: PieceEndpoint }>()

  const link = (first: PieceEndpoint, second: PieceEndpoint): void => {
    links.set(endpointKey(first), second)
    links.set(endpointKey(second), first)
  }

  for (const segment of network.segments) {
    const ordered = [...segment.collisionPieces].sort(
      (first, second) => first.startS - second.startS,
    )
    if (ordered.length === 0) continue
    for (const piece of ordered) pieces.set(piece.id, piece)
    for (let index = 0; index < ordered.length - 1; index += 1) {
      link(
        { pieceId: ordered[index]!.id, endpoint: 'end' },
        { pieceId: ordered[index + 1]!.id, endpoint: 'start' },
      )
    }
    boundaries.set(segment.id, {
      start: { pieceId: ordered[0]!.id, endpoint: 'start' },
      end: { pieceId: ordered.at(-1)!.id, endpoint: 'end' },
    })
  }

  for (const segment of network.segments) {
    const ownBoundaries = boundaries.get(segment.id)
    if (!ownBoundaries) continue
    for (const endpoint of ['start', 'end'] as const) {
      const neighbor = segment.neighbors[endpoint]
      if (!neighbor) continue
      const neighborBoundaries = boundaries.get(neighbor.segmentId)
      if (!neighborBoundaries) continue
      link(ownBoundaries[endpoint], neighborBoundaries[neighbor.endpoint])
    }
  }

  const unvisited = new Set(pieces.keys())
  const chains: GroundCollisionChain[] = []

  const appendChain = (firstPieceId: string, firstEntry: Endpoint): void => {
    const firstPiece = pieces.get(firstPieceId)
    if (!firstPiece || !unvisited.has(firstPieceId)) return
    const material = firstPiece.material
    const conveyor = conveyorForPiece(network, firstPiece)
    const points: Vec2[] = []
    const pieceIds: string[] = []
    const startConnected = links.has(endpointKey({ pieceId: firstPieceId, endpoint: firstEntry }))
    let endConnected = false
    let current: PieceEndpoint | null = {
      pieceId: firstPieceId,
      endpoint: firstEntry,
    }

    while (current && unvisited.has(current.pieceId)) {
      const piece = pieces.get(current.pieceId)
      if (!piece || !sameChainProperties(network, firstPiece, piece)) break
      unvisited.delete(piece.id)
      pieceIds.push(piece.id)
      const nextPoints = orientedPoints(piece, current.endpoint)
      if (points.length > 0 && nextPoints.length > 0 && samePoint(points.at(-1)!, nextPoints[0]!)) {
        nextPoints.shift()
      }
      points.push(...nextPoints)

      const exit = opposite(current.endpoint)
      const linked = links.get(endpointKey({ pieceId: piece.id, endpoint: exit }))
      const linkedPiece = linked ? pieces.get(linked.pieceId) : null
      endConnected = Boolean(linked)
      current =
        linked && linkedPiece && sameChainProperties(network, firstPiece, linkedPiece)
          ? linked
          : null
    }

    if (points.length >= 2) {
      const isClosed = points.length > 2 && samePoint(points[0]!, points.at(-1)!)
      chains.push({
        points: withoutCollinearInteriorPoints(points),
        material,
        pieceIds,
        conveyor: { ...conveyor },
        conveyorSpeedAlongPointsMps: conveyor.enabled
          ? conveyor.speedMps *
            (conveyor.direction === 'forward' ? 1 : -1) *
            pieceDirectionMatchesSourceGround(network, firstPiece) *
            (firstEntry === 'start' ? 1 : -1)
          : 0,
        closed: isClosed,
        startConnected: startConnected || isClosed,
        endConnected: endConnected || isClosed,
      })
    }
  }

  for (const piece of pieces.values()) {
    if (!unvisited.has(piece.id)) continue
    const boundary = (['start', 'end'] as const).find((endpoint) => {
      const linked = links.get(endpointKey({ pieceId: piece.id, endpoint }))
      const neighbor = linked ? pieces.get(linked.pieceId) : null
      return !neighbor || !sameChainProperties(network, piece, neighbor)
    })
    if (boundary) appendChain(piece.id, boundary)
  }

  for (const pieceId of [...unvisited]) appendChain(pieceId, 'start')
  return chains
}
