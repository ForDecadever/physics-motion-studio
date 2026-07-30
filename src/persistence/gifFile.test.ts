import { describe, expect, it } from 'vitest'

import { normalizedGifFileName } from './gifFile'

describe('GIF file persistence', () => {
  it('normalizes the GIF extension without duplicating it', () => {
    expect(normalizedGifFileName('demo')).toBe('demo.gif')
    expect(normalizedGifFileName('demo.GIF')).toBe('demo.GIF')
    expect(normalizedGifFileName('  ')).toBe('motion-studio.gif')
  })
})
