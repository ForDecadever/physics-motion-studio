import {
  DEFAULT_ENTITY_CREATION_DEFAULTS,
  type EntityCreationDefaults,
} from '../scene/model/creationDefaults'

const STORAGE_KEY = 'motion-studio-preferences-v3'
const LEGACY_STORAGE_KEYS = ['motion-studio-preferences-v2', 'motion-studio-preferences-v1']

export interface AppPreferences {
  version: 3
  editor: {
    gridVisible: boolean
    snapEnabled: boolean
    wallSnapEnabled: boolean
    blockSnapEnabled: boolean
  }
  creation: EntityCreationDefaults
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  version: 3,
  editor: {
    gridVisible: true,
    snapEnabled: true,
    wallSnapEnabled: true,
    blockSnapEnabled: true,
  },
  creation: structuredClone(DEFAULT_ENTITY_CREATION_DEFAULTS),
}

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function finiteInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = finite(value, fallback, minimum, maximum)
  return Number.isInteger(parsed) ? parsed : fallback
}

export function loadAppPreferences(): AppPreferences {
  try {
    const stored =
      localStorage.getItem(STORAGE_KEY) ??
      LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find((value) => value !== null)
    const input = JSON.parse(stored ?? 'null') as Partial<Omit<AppPreferences, 'version'>> & {
      version?: number
    }
    if (!input || (input.version !== 1 && input.version !== 2 && input.version !== 3)) {
      return structuredClone(DEFAULT_APP_PREFERENCES)
    }
    const defaults = DEFAULT_APP_PREFERENCES
    const creation = input.creation
    return {
      version: 3,
      editor: {
        gridVisible: boolean(input.editor?.gridVisible, defaults.editor.gridVisible),
        snapEnabled: boolean(input.editor?.snapEnabled, defaults.editor.snapEnabled),
        wallSnapEnabled: boolean(input.editor?.wallSnapEnabled, defaults.editor.wallSnapEnabled),
        blockSnapEnabled: boolean(input.editor?.blockSnapEnabled, defaults.editor.blockSnapEnabled),
      },
      creation: {
        body: {
          massKg: finite(creation?.body?.massKg, defaults.creation.body.massKg, 1e-9, 1e12),
          ballColor: color(creation?.body?.ballColor, defaults.creation.body.ballColor),
          blockColor: color(creation?.body?.blockColor, defaults.creation.body.blockColor),
          ballCollisionEnabled: boolean(
            creation?.body?.ballCollisionEnabled,
            defaults.creation.body.ballCollisionEnabled,
          ),
          friction: finite(creation?.body?.friction, defaults.creation.body.friction, 0, 5),
          restitution: finite(
            creation?.body?.restitution,
            defaults.creation.body.restitution,
            0,
            1,
          ),
        },
        ground: {
          friction: finite(creation?.ground?.friction, defaults.creation.ground.friction, 0, 5),
          restitution: finite(
            creation?.ground?.restitution,
            defaults.creation.ground.restitution,
            0,
            1,
          ),
          conveyorEnabled: boolean(
            creation?.ground?.conveyorEnabled,
            defaults.creation.ground.conveyorEnabled,
          ),
          conveyorDirection:
            creation?.ground?.conveyorDirection === 'reverse' ? 'reverse' : 'forward',
          conveyorSpeedMps: finite(
            creation?.ground?.conveyorSpeedMps,
            defaults.creation.ground.conveyorSpeedMps,
            0,
            1e6,
          ),
        },
        field: {
          gravityMps2: finite(
            creation?.field?.gravityMps2,
            defaults.creation.field.gravityMps2,
            0,
            1e9,
          ),
          electricNPerC: finite(
            creation?.field?.electricNPerC,
            defaults.creation.field.electricNPerC,
            -1e15,
            1e15,
          ),
          magneticTesla: finite(
            creation?.field?.magneticTesla,
            defaults.creation.field.magneticTesla,
            -1e12,
            1e12,
          ),
        },
        particleSource: {
          speedMps: finite(
            creation?.particleSource?.speedMps,
            defaults.creation.particleSource.speedMps,
            0,
            1e9,
          ),
          chargeC: finite(
            input.version === 3 ? creation?.particleSource?.chargeC : undefined,
            defaults.creation.particleSource.chargeC,
            -1e12,
            1e12,
          ),
          massKg: finite(
            creation?.particleSource?.massKg,
            defaults.creation.particleSource.massKg,
            1e-12,
            1e12,
          ),
        },
        force: {
          magnitudeN: finite(
            creation?.force?.magnitudeN,
            defaults.creation.force.magnitudeN,
            -1e15,
            1e15,
          ),
          directionRad: finite(
            creation?.force?.directionRad,
            defaults.creation.force.directionRad,
            -1e9,
            1e9,
          ),
        },
        recording: {
          sampleRate: finiteInteger(
            creation?.recording?.sampleRate,
            defaults.creation.recording.sampleRate,
            1,
            120,
          ),
          durationSeconds: finiteInteger(
            creation?.recording?.durationSeconds,
            defaults.creation.recording.durationSeconds,
            1,
            3600,
          ),
        },
      },
    }
  } catch {
    return structuredClone(DEFAULT_APP_PREFERENCES)
  }
}

export function saveAppPreferences(preferences: AppPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}
