export function conveyorMarkerDistance(
  pathLength: number,
  speedMps: number,
  direction: 'forward' | 'reverse',
  simulationTime: number,
): number {
  if (pathLength <= Number.EPSILON) return 0
  const origin = direction === 'forward' ? 0 : pathLength
  if (speedMps <= 0 || simulationTime <= 0) return origin
  const traveled = (speedMps * simulationTime) % pathLength
  return direction === 'forward' ? traveled : pathLength - traveled
}
