import type { PlanInput, TimeRule } from '@zhchxiao123/dsh-scheduler'
/** Reject malformed durable and command objects before they enter scheduling. */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBJECT')
  return value as Record<string, unknown>
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_TEXT')
  return value
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('INVALID_NUMBER')
  return value
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('INVALID_BOOLEAN')
  return value
}
export function decodeInput(value: unknown): PlanInput {
  const input = record(value)
  const rule = record(input.rule)
  let timeRule: TimeRule
  if (rule.kind === 'interval') timeRule = { kind: 'interval', everyMs: number(rule.everyMs) }
  else if (rule.kind === 'cron')
    timeRule = { kind: 'cron', expression: text(rule.expression), timezone: text(rule.timezone) }
  else throw new Error('INVALID_TIME_RULE')
  if (input.misfire !== undefined && input.misfire !== 'latest' && input.misfire !== 'skip')
    throw new Error('INVALID_MISFIRE')
  return {
    projectId: input.projectId === undefined || input.projectId === null ? '' : text(input.projectId),
    name: text(input.name),
    handler: text(input.handler),
    params: input.params,
    rule: timeRule,
    ...(input.misfire !== undefined ? { misfire: input.misfire } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: number(input.maxAttempts) } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: number(input.timeoutMs) } : {}),
  }
}
