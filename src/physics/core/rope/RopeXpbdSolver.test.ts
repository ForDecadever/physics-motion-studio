import { describe, expect, it, vi } from 'vitest'

import { requiredRopeXpbdMicrosteps, solveRopeXpbd } from './RopeXpbdSolver'

describe('RopeXpbdSolver', () => {
  it('根据扫掠距离自适应选择 1 到 8 个局部子步', () => {
    expect(requiredRopeXpbdMicrosteps(0, 0.05, 0.1)).toBe(1)
    expect(requiredRopeXpbdMicrosteps(0.09, 0.05, 0.1)).toBe(1)
    expect(requiredRopeXpbdMicrosteps(0.21, 0.05, 0.1)).toBe(3)
    expect(requiredRopeXpbdMicrosteps(100, 0.05, 0.1)).toBe(8)
  })

  it('统一完成位置约束后只重建一次速度，再执行速度约束', () => {
    const order: string[] = []
    const rebuildVelocities = vi.fn(() => order.push('rebuild'))

    solveRopeXpbd(
      {
        microsteps: 2,
        positionIterationsPerMicrostep: 2,
        velocityIterations: 1,
        lengthToleranceM: 1e-5,
        penetrationToleranceM: 1e-5,
        velocityToleranceMps: 1e-5,
      },
      {
        beginSolve: () => order.push('begin'),
        capturePositionsBeforeLengthProjection: () => order.push('capture'),
        solveLengthPositions: (reverse) => {
          order.push(`length-position-${reverse}`)
          return 1
        },
        refreshContactsAfterLengthProjection: () => order.push('refresh-contact'),
        solveContactPositions: (reverse) => {
          order.push(`contact-position-${reverse}`)
          return {
            corrected: true,
            maximumConstraintErrorM: 1,
            maximumPenetrationM: 1,
          }
        },
        measureLengthPositionError: () => 1,
        rebuildVelocities,
        solveContactVelocities: (reverse) => {
          order.push(`contact-velocity-${reverse}`)
          return false
        },
        solveLengthVelocities: (reverse) => {
          order.push(`length-velocity-${reverse}`)
          return 0
        },
        finishSolve: () => order.push('finish'),
      },
    )

    expect(rebuildVelocities).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe('begin')
    expect(order.slice(1, 5)).toEqual([
      'capture',
      'length-position-false',
      'refresh-contact',
      'contact-position-false',
    ])
    expect(order.at(-4)).toBe('rebuild')
    expect(order.slice(-3)).toEqual(['contact-velocity-false', 'length-velocity-false', 'finish'])
    const rebuildIndex = order.indexOf('rebuild')
    expect(order[rebuildIndex - 1]).toMatch(/^contact-position-/)
    expect(order.slice(0, rebuildIndex).filter((entry) => entry === 'capture')).toHaveLength(8)
  })

  it('绳长与接触误差必须同时收敛，并在 32 次预算后报告失败', () => {
    const solveContactPositions = vi.fn(() => ({
      corrected: true,
      maximumConstraintErrorM: 0,
      maximumPenetrationM: 1,
    }))
    const result = solveRopeXpbd(
      {
        microsteps: 8,
        positionIterationsPerMicrostep: 4,
        velocityIterations: 1,
        lengthToleranceM: 1e-5,
        penetrationToleranceM: 1e-5,
        velocityToleranceMps: 1e-5,
      },
      {
        beginSolve: () => {},
        capturePositionsBeforeLengthProjection: () => {},
        solveLengthPositions: () => 1,
        refreshContactsAfterLengthProjection: () => {},
        solveContactPositions,
        measureLengthPositionError: () => 1,
        rebuildVelocities: () => {},
        solveContactVelocities: () => false,
        solveLengthVelocities: () => 0,
        finishSolve: () => {},
      },
    )

    expect(result).toMatchObject({
      converged: false,
      positionIterations: 32,
      maximumLengthErrorM: 1,
      maximumPenetrationM: 1,
    })
    expect(solveContactPositions).toHaveBeenCalledTimes(36)
  })

  it('接触闭合至少刷新两轮后才允许提前收敛', () => {
    const capturePositions = vi.fn()
    const result = solveRopeXpbd(
      {
        microsteps: 1,
        positionIterationsPerMicrostep: 4,
        minimumPositionIterations: 2,
        velocityIterations: 1,
        lengthToleranceM: 1e-4,
        penetrationToleranceM: 1e-5,
        velocityToleranceMps: 1e-5,
      },
      {
        beginSolve: () => {},
        capturePositionsBeforeLengthProjection: capturePositions,
        solveLengthPositions: () => 0,
        refreshContactsAfterLengthProjection: () => {},
        solveContactPositions: () => ({
          corrected: false,
          maximumConstraintErrorM: 0,
          maximumPenetrationM: 0,
        }),
        measureLengthPositionError: () => 0,
        rebuildVelocities: () => {},
        solveContactVelocities: () => false,
        solveLengthVelocities: () => 0,
        finishSolve: () => {},
      },
    )

    expect(result).toMatchObject({ converged: true, positionIterations: 2 })
    expect(capturePositions).toHaveBeenCalledTimes(2)
  })
})
