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
