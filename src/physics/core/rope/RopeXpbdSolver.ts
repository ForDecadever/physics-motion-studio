export interface RopeXpbdPositionResult {
  corrected: boolean
  maximumConstraintErrorM: number
  maximumPenetrationM: number
}

export interface RopeXpbdHooks {
  beginSolve(): void
  capturePositionsBeforeLengthProjection(): void
  solveLengthPositions(reverse: boolean): number
  refreshContactsAfterLengthProjection(): void
  solveContactPositions(reverse: boolean): RopeXpbdPositionResult
  measureLengthPositionError(): number
  rebuildVelocities(): void
  solveContactVelocities(reverse: boolean): boolean
  solveLengthVelocities(reverse: boolean): number
  finishSolve(): void
}

export interface RopeXpbdOptions {
  microsteps: number
  positionIterationGroups?: number
  positionIterationsPerMicrostep: number
  minimumPositionIterations?: number
  velocityIterations: number
  lengthToleranceM: number
  penetrationToleranceM: number
  velocityToleranceMps: number
}

export function requiredRopeXpbdMicrosteps(
  maximumRelativeTravelM: number,
  radiusM: number,
  linkLengthM: number,
): number {
  if (!Number.isFinite(maximumRelativeTravelM) || maximumRelativeTravelM <= 0) return 1
  const safeFeatureSize = Math.max(2 * Math.max(0, radiusM), Math.max(0, linkLengthM), 1e-6)
  return Math.min(8, Math.max(1, Math.ceil(maximumRelativeTravelM / safeFeatureSize)))
}

export interface RopeXpbdSolveResult {
  converged: boolean
  positionIterations: number
  maximumLengthErrorM: number
  maximumPenetrationM: number
}

const MAXIMUM_FINAL_CONTACT_PROJECTION_PASSES = 4

export function solveRopeXpbd(options: RopeXpbdOptions, hooks: RopeXpbdHooks): RopeXpbdSolveResult {
  const microsteps = Math.min(8, Math.max(1, Math.floor(options.microsteps)))
  const positionIterationGroups = Math.min(
    8,
    Math.max(1, Math.floor(options.positionIterationGroups ?? microsteps)),
  )
  const positionIterations = Math.min(
    32,
    Math.max(
      8,
      positionIterationGroups * Math.max(1, Math.floor(options.positionIterationsPerMicrostep)),
    ),
  )
  const minimumPositionIterations = Math.min(
    positionIterations,
    Math.max(1, Math.floor(options.minimumPositionIterations ?? microsteps)),
  )
  const velocityIterations = Math.max(1, Math.floor(options.velocityIterations))
  hooks.beginSolve()

  let maximumLengthErrorM = Number.POSITIVE_INFINITY
  let maximumPenetrationM = Number.POSITIVE_INFINITY
  let usedPositionIterations = 0
  let converged = false
  for (let iteration = 0; iteration < positionIterations; iteration += 1) {
    const reverse = iteration % 2 === 1
    hooks.capturePositionsBeforeLengthProjection()
    hooks.solveLengthPositions(reverse)
    hooks.refreshContactsAfterLengthProjection()
    const contact = hooks.solveContactPositions(reverse)
    maximumLengthErrorM = hooks.measureLengthPositionError()
    maximumPenetrationM = Math.max(contact.maximumConstraintErrorM, contact.maximumPenetrationM)
    usedPositionIterations = iteration + 1
    if (
      usedPositionIterations >= minimumPositionIterations &&
      maximumPenetrationM <= options.penetrationToleranceM &&
      maximumLengthErrorM <= options.lengthToleranceM
    ) {
      converged = true
      break
    }
  }

  if (!converged && maximumPenetrationM > options.penetrationToleranceM) {
    for (let pass = 0; pass < MAXIMUM_FINAL_CONTACT_PROJECTION_PASSES; pass += 1) {
      const contact = hooks.solveContactPositions((usedPositionIterations + pass) % 2 === 1)
      maximumLengthErrorM = hooks.measureLengthPositionError()
      maximumPenetrationM = Math.max(contact.maximumConstraintErrorM, contact.maximumPenetrationM)
      if (maximumPenetrationM <= options.penetrationToleranceM) {
        converged = maximumLengthErrorM <= options.lengthToleranceM
        break
      }
    }
  }

  hooks.rebuildVelocities()
  for (let iteration = 0; iteration < velocityIterations; iteration += 1) {
    const reverse = iteration % 2 === 1
    const corrected = hooks.solveContactVelocities(reverse)
    const velocityError = hooks.solveLengthVelocities(reverse)
    if (!corrected && velocityError <= options.velocityToleranceMps) break
  }
  hooks.finishSolve()
  return {
    converged,
    positionIterations: usedPositionIterations,
    maximumLengthErrorM,
    maximumPenetrationM,
  }
}
