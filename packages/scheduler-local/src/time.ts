import { copyJson } from './json.ts'
import { CronExpressionParser } from 'cron-parser'
import type { PlanInput, TimeRule } from '@zhchxiao123/dsh-scheduler'
/** Validate at the command/config boundary before durable insertion. */
export function validateInput(input: PlanInput): unknown {
  if (!input.name.trim() || !input.handler.trim()) throw new Error('NAME_AND_HANDLER_REQUIRED')
  for (const value of [input.maxAttempts ?? 3, input.timeoutMs ?? 30000])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_LIMIT')
  nextTime(input.rule, Date.now())
  return copyJson(input.params)
}
/** Return the next strictly later occurrence. */
export function nextTime(rule: TimeRule, after: number): number {
  if (rule.kind === 'interval') {
    if (!Number.isSafeInteger(rule.everyMs) || rule.everyMs < 1) throw new Error('INVALID_INTERVAL')
    return after + rule.everyMs
  }
  if (rule.expression.trim().split(/\s+/).length !== 5) throw new Error('FIVE_FIELD_CRON_REQUIRED')
  new Intl.DateTimeFormat('en-US', { timeZone: rule.timezone }).format()
  const expression = CronExpressionParser.parse(rule.expression, { currentDate: new Date(after), tz: rule.timezone })
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: rule.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  // cron-parser rolls missing local hours forward. The product contract skips them.
  for (;;) {
    const candidate = expression.next().getTime()
    const parts = formatter.formatToParts(candidate)
    const hour = Number(parts.find(part => part.type === 'hour')?.value)
    const minute = Number(parts.find(part => part.type === 'minute')?.value)
    if (
      expression.fields.hour.values.some(value => value === hour) &&
      expression.fields.minute.values.some(value => value === minute)
    )
      return candidate
  }
}

/** Identify the most recent due occurrence without replaying all missed cycles. */
export function latestTime(rule: TimeRule, firstDue: number, now: number): number {
  if (rule.kind === 'interval') return firstDue + Math.floor((now - firstDue) / rule.everyMs) * rule.everyMs
  const expression = CronExpressionParser.parse(rule.expression, { currentDate: new Date(now + 1), tz: rule.timezone })
  return Math.max(expression.prev().getTime(), firstDue)
}
