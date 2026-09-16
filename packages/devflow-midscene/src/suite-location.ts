/** Approved suite bytes have their own hash; other Devflow runtime state is never executable test input. */
import { join, relative, resolve } from 'node:path'
import { within } from './identity.ts'

export function assertSuiteLocation(workspace: string, suite: string, requestedWorkspace: string, requestedSuite: string): void {
  if (!within(join(workspace, '.devflow'), suite)) return
  const requested = resolve(workspace, relative(resolve(requestedWorkspace), resolve(requestedSuite)))
  if (!within(join(workspace, '.devflow', 'midscene', 'suites'), suite) || requested !== resolve(suite))
    throw new Error('Suite must be outside Devflow runtime state or a direct file under .devflow/midscene/suites')
}
