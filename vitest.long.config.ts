import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.longbench.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
