import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    pool: 'forks',
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['packages/shell/tool-bash/tests/tools.spec.ts'],
  },
})
