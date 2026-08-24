import { afterEach, describe, expect, it } from 'vitest'

import { createEmptyScene } from './createEmptyScene'
import {
  DEFAULT_ENTITY_CREATION_DEFAULTS,
  configureEntityCreationDefaults,
} from './creationDefaults'
import {
  createBall,
  createForce,
  createLineGround,
  createMagneticField,
  createParticleSource,
} from './entityFactories'

afterEach(() => configureEntityCreationDefaults(DEFAULT_ENTITY_CREATION_DEFAULTS))

describe('新建对象默认值', () => {
  it('只影响之后创建的对象和新场景，不反向修改已有对象', () => {
    const existing = createBall('', { x: 0, y: 0 }, 1, 1)
    const defaults = structuredClone(DEFAULT_ENTITY_CREATION_DEFAULTS)
    defaults.body.massKg = 7
    defaults.body.ballColor = '#123456'
    defaults.body.friction = 0.4
    defaults.ground.conveyorEnabled = true
    defaults.ground.conveyorDirection = 'reverse'
    defaults.ground.conveyorSpeedMps = 3
    defaults.field.magneticTesla = 2.5
    defaults.particleSource.speedMps = 12
    defaults.force.magnitudeN = 25
    defaults.recording.sampleRate = 30
    defaults.recording.durationSeconds = 120
    configureEntityCreationDefaults(defaults)

    const ball = createBall('', { x: 0, y: 0 }, 1, 2)
    const ground = createLineGround('', { x: -1, y: 0 }, { x: 1, y: 0 }, 1)
    const field = createMagneticField('', { x: 0, y: 0 }, 2, 2, 1)
    const source = createParticleSource('', { type: 'point', position: { x: 0, y: 0 } }, 1)
    const force = createForce('', ball.id, { x: 0, y: 0 }, 1)
    const scene = createEmptyScene()

    expect(existing).toMatchObject({ massKg: 1, color: '#e45d68' })
    expect(ball).toMatchObject({ massKg: 7, color: '#123456', material: { friction: 0.4 } })
    expect(ground.conveyor).toEqual({ enabled: true, direction: 'reverse', speedMps: 3 })
    expect(field.field).toMatchObject({ type: 'uniformMagnetic', bzTesla: 2.5 })
    expect(source).toMatchObject({ speedMps: 12, chargeC: 1 })
    expect(force.magnitudeN).toBe(25)
    expect(scene.settings).toMatchObject({
      recordingSampleRate: 30,
      recordingDurationSeconds: 120,
    })
  })
})
