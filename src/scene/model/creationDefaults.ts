export interface EntityCreationDefaults {
  body: {
    massKg: number
    ballColor: string
    blockColor: string
    ballCollisionEnabled: boolean
    friction: number
    restitution: number
  }
  ground: {
    friction: number
    restitution: number
    conveyorEnabled: boolean
    conveyorDirection: 'forward' | 'reverse'
    conveyorSpeedMps: number
  }
  field: { gravityMps2: number; electricNPerC: number; magneticTesla: number }
  particleSource: { speedMps: number; chargeC: number; massKg: number }
  force: { magnitudeN: number; directionRad: number }
  recording: { sampleRate: number; durationSeconds: number }
}

export const DEFAULT_ENTITY_CREATION_DEFAULTS: EntityCreationDefaults = {
  body: {
    massKg: 1,
    ballColor: '#e45d68',
    blockColor: '#4e9eeb',
    ballCollisionEnabled: true,
    friction: 0,
    restitution: 0,
  },
  ground: {
    friction: 0,
    restitution: 0,
    conveyorEnabled: false,
    conveyorDirection: 'forward',
    conveyorSpeedMps: 1,
  },
  field: { gravityMps2: 9.80665, electricNPerC: 1e6, magneticTesla: 1 },
  particleSource: { speedMps: 1, chargeC: 1, massKg: 1 },
  force: { magnitudeN: 10, directionRad: 0 },
  recording: { sampleRate: 60, durationSeconds: 300 },
}

let currentDefaults = structuredClone(DEFAULT_ENTITY_CREATION_DEFAULTS)

export function configureEntityCreationDefaults(defaults: EntityCreationDefaults): void {
  currentDefaults = structuredClone(defaults)
}

export function getEntityCreationDefaults(): EntityCreationDefaults {
  return currentDefaults
}
