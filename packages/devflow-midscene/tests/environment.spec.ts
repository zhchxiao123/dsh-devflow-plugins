import { afterEach, expect, it, vi } from 'vitest'
import { childEnvironment } from '../src/environment.ts'

afterEach(() => vi.unstubAllEnvs())

it('isolates managed SDK settings while retaining the system environment and explicit operation values', () => {
  vi.stubEnv('MIDSCENE_INSIGHT_MODEL_NAME', 'ambient-model')
  vi.stubEnv('MIDSCENE_INSIGHT_MODEL_API_KEY', 'ambient-key')
  vi.stubEnv('MIDSCENE_MODEL_FAMILY', 'ambient-family')
  vi.stubEnv('PATH', '/system/bin')
  const child = childEnvironment({ MIDSCENE_MODEL_NAME: 'selected', MIDSCENE_RUN_DIR: '/private/run' })
  expect(child.MIDSCENE_INSIGHT_MODEL_NAME).toBeUndefined()
  expect(child.MIDSCENE_INSIGHT_MODEL_API_KEY).toBeUndefined()
  expect(child.MIDSCENE_MODEL_FAMILY).toBeUndefined()
  expect(child).toMatchObject({ PATH: '/system/bin', MIDSCENE_MODEL_NAME: 'selected', MIDSCENE_RUN_DIR: '/private/run' })
  expect(process.env.MIDSCENE_INSIGHT_MODEL_NAME).toBe('ambient-model')
  expect(childEnvironment().MIDSCENE_INSIGHT_MODEL_NAME).toBe('ambient-model')
})
