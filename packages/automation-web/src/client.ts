/** Browser-safe API: validated snapshots and explicit abort ownership, without host imports. */
import { envelopeSchema, results } from './schema.ts'
import type { AutomationRequest, AutomationResult } from './types.ts'
export type * from './types.ts'
export async function automationRequest<T extends AutomationRequest>(request: T, signal?: AbortSignal): Promise<AutomationResult<T>> {
  const response = await fetch('/automation/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`automation-http-${response.status}`)
  const envelope = envelopeSchema.parse(await response.json())
  if (!envelope.ok) throw new Error(envelope.error)
  // The method selects the schema and the corresponding conditional result type.
  return results[request.method].parse(envelope.data) as AutomationResult<T>
}
