import type { AuditSummary, EvaluationRecord, EvaluationSummary, WebRequest } from '../index.ts'
type Result<T extends WebRequest> = T['method'] extends 'list' ? EvaluationSummary[] : T['method'] extends 'audit-list' ? AuditSummary[] : T['method'] extends 'audit-read' ? AuditSummary : T['method'] extends 'read' | 'accept' | 'reject' | 'assess' ? EvaluationRecord : { runId?: string; jobId?: string; manifest?: AuditSummary['manifest']; state?: AuditSummary['state']; outcome?: string }
export async function request<T extends WebRequest>(input: T, signal?: AbortSignal): Promise<Result<T>> {
  const response = await fetch('/devflow/jev/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), ...(signal === undefined ? {} : { signal }) })
  if (!response.ok) throw new Error(`devflow-jev-http-${response.status}`)
  const envelope: unknown = await response.json()
  if (typeof envelope !== 'object' || envelope === null || Reflect.get(envelope, 'ok') !== true) throw new Error(String(typeof envelope === 'object' && envelope !== null ? Reflect.get(envelope, 'error') : 'invalid-response'))
  return Reflect.get(envelope, 'data') as Result<T>
}
