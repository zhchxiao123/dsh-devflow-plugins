import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      thresholds: { perFile: true, lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
})
