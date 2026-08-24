import type { ForceAnalysisCategory, ForceAnalysisEntry } from './forceAnalysis'

const BASE_FORCE_COLORS: Record<ForceAnalysisCategory, number> = {
  gravity: 0x9b8cff,
  electric: 0xf2c94c,
  magnetic: 0x59c6bd,
  coulomb: 0xff7f6e,
  external: 0xffb45e,
  connector: 0x67b7ff,
  contact: 0xf28fb3,
  constraint: 0xb6c2d1,
  net: 0x72d6a0,
}

const CONNECTOR_COLORS = [0x67b7ff, 0x5dd6c0, 0xf0a35e, 0xc58cff, 0x78d56f]
const CONTACT_COLORS = [0xf28fb3, 0xff8b74, 0xe3c65b, 0x73d1e8, 0xb7d672]

function stablePaletteIndex(key: string, length: number): number {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0
  return Math.abs(hash) % length
}

export function forceColorNumber(entry: Pick<ForceAnalysisEntry, 'key' | 'category'>): number {
  if (entry.category === 'connector') {
    return CONNECTOR_COLORS[stablePaletteIndex(entry.key, CONNECTOR_COLORS.length)]!
  }
  if (entry.category === 'contact') {
    return CONTACT_COLORS[stablePaletteIndex(entry.key, CONTACT_COLORS.length)]!
  }
  return BASE_FORCE_COLORS[entry.category]
}

export function forceColorCss(entry: Pick<ForceAnalysisEntry, 'key' | 'category'>): string {
  return `#${forceColorNumber(entry).toString(16).padStart(6, '0')}`
}
