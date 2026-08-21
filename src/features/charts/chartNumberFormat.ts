export function formatChartNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Object.is(value, -0) || value === 0) return '0'

  const absolute = Math.abs(value)
  if (absolute >= 1_000_000 || absolute < 0.0001) {
    const [coefficient = '0', exponent = '0'] = value.toExponential(5).split('e')
    return `${Number(coefficient)}e${Number(exponent)}`
  }
  return String(Number(value.toPrecision(6)))
}

export interface ChartAxisRange {
  min: number
  max: number
}

export function resolveConstantChartAxisRange(
  dataMin: number,
  dataMax: number,
): ChartAxisRange | null {
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMin > dataMax) return null

  const center = (dataMin + dataMax) / 2
  const magnitude = Math.max(Math.abs(dataMin), Math.abs(dataMax), 0.001)
  const constantTolerance = Math.max(magnitude * 1e-6, 1e-9)
  if (dataMax - dataMin > constantTolerance) return null

  const magnitudeExponent = Math.floor(Math.log10(magnitude))
  const centerQuantum = Math.max(10 ** (magnitudeExponent - 4), 1e-6)
  const stableCenter = Math.round(center / centerQuantum) * centerQuantum
  const padding = Math.max(Math.abs(stableCenter) * 0.05, 0.001)
  return { min: stableCenter - padding, max: stableCenter + padding }
}
