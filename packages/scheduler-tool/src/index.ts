/** Native tools over the scheduler seam. Receipt acceptance never implies downstream completion. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ToolResult, InferValue } from '@deepseek-ai/dsh-tools'
import type { Plan } from '@zhchxiao123/dsh-scheduler'
export const name = 'scheduler-tool'
export const inject = ['tools', 'scheduler']

const text = { type: 'string', required: true } as const
const number = { type: 'integer', required: true } as const
const rule = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'interval', required: true }, everyMs: number } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'cron', required: true }, expression: text, timezone: text } },
  ],
  required: true,
} as const
const planInput = {
  name: { ...text, description: 'Human-readable purpose of this plan.' },
  handler: { ...text, description: 'Registered handler name. GitHub sync uses github.sync.' },
  params: { type: 'json', required: true, description: 'Handler-specific JSON; github.sync requires exactly {subscriptionId: "..."}.' },
  rule,
  misfire: { type: 'string', enum: ['latest', 'skip'] },
  maxAttempts: { type: 'integer' },
  timeoutMs: { type: 'integer' },
} as const
const planSchema = {
  type: 'object', additionalProperties: false,
  properties: { ...planInput, id: text, enabled: { type: 'boolean', required: true }, deleted: { type: 'boolean', required: true }, nextAt: number, createdBy: text, updatedBy: text },
} as const
const triggerSchema = {
  type: 'object', additionalProperties: false,
  properties: { id: text, planId: text, scheduledAt: number, state: { ...text, enum: ['pending', 'delivering', 'accepted', 'completed', 'failed', 'cancelled', 'partial'] }, attempts: number, runId: { type: 'string' }, error: { type: 'string' }, acceptedAt: { type: 'integer' }, completedAt: { type: 'integer' }, requestedBy: text },
} as const
/** Provider-owned params are unknown at the seam; defineTool validates the entire wire value as lossless JSON before rendering. */
function planValue(plan: Plan): InferValue<typeof planSchema> {
  return { ...plan, params: plan.params as InferValue<typeof planSchema>['params'] }
}
/** Mutations have the authenticated tool execution identity, never a model-provided actor. */
function actor(exec: ToolRunContext): string {
  exec.signal.throwIfAborted()
  if (exec.agent === undefined) throw new Error('Scheduler mutations require an owning agent session')
  return `agent:${exec.agent.id}/tool:${exec.callId}`
}
/** Native cards preserve error text and operation-specific accepted/query results. */
function presentResult(_args: unknown, result: ToolResult) {
  return { card: 'generic' as const, title: result.isError ? '调度操作失败' : '调度操作结果', content: [{ type: 'text' as const, text: result.content.filter(block => block.type === 'text').map(block => block.text.split('\n')[0]).join('\n') }] }
}
/** Register tools for the lifetime of the injected consumer. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'scheduler_query', description: 'List durable plans and delivery history. Filter by planId to inspect a plan. nextAt is UTC epoch milliseconds. An accepted trigger is not completed work; follow its runId with the handler-specific run tool.',
    parameters: { planId: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { plans: { type: 'array', items: planSchema, required: true }, triggers: { type: 'array', items: triggerSchema, required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Scheduler: ${value.plans.length} plans, ${value.triggers.length} delivery records.\n${JSON.stringify(value, null, 2)}` }],
    },
    execute: async args => ({
      plans: (await ctx.scheduler.list()).filter(plan => args.planId === undefined || plan.id === args.planId).map(planValue),
      triggers: await ctx.scheduler.history(args.planId),
    }),
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', kind: 'read', title: '查看定时计划与投递记录', rawInput: args.planId }), presentResult,
  }))
  ctx.tools.register(defineTool({
    name: 'scheduler_configure', description: 'Create a scheduler plan, or replace its configuration when planId is supplied. Query existing plans first to avoid duplicates and preserve settings. Interval everyMs is positive milliseconds; Cron requires expression and IANA timezone. Services validate handler parameters and scheduling constraints.',
    parameters: { planId: { type: 'string' }, ...planInput },
    output: { schema: planSchema, render: (_args, plan) => [{ type: 'text', text: `Plan saved: ${plan.name} (${plan.id}); enabled=${plan.enabled}; nextAt=${new Date(plan.nextAt).toISOString()}.\n${JSON.stringify(plan, null, 2)}` }] },
    execute: async (args, exec) => {
      const { planId } = args
      const input = {
        name: args.name, handler: args.handler, params: args.params, rule: args.rule,
        ...args.misfire === undefined ? {} : { misfire: args.misfire },
        ...args.maxAttempts === undefined ? {} : { maxAttempts: args.maxAttempts },
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
      }
      const owner = actor(exec)
      const saved = planId === undefined
        ? await ctx.scheduler.create(input, owner)
        : await ctx.scheduler.update(planId, input, owner)
      return planValue(saved)
    },
    presentCall: args => ({ card: 'generic', kind: 'edit', title: `保存定时计划：${args.name}`, rawInput: args.rule }), presentResult,
  }))
  ctx.tools.register(defineTool({
    name: 'scheduler_manage', description: 'Pause, resume or delete one plan. Deleting prevents future scheduling; it does not cancel already accepted work. Use scheduler_trigger action cancel for one delivery.',
    parameters: { planId: text, action: { ...text, enum: ['pause', 'resume', 'delete'] } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { planId: text, action: text } }, render: (_args, value) => [{ type: 'text', text: `Plan ${value.planId}: ${value.action} applied.` }] },
    execute: async (args, exec) => {
      const owner = actor(exec)
      if (args.action === 'pause') await ctx.scheduler.pause(args.planId, owner)
      else if (args.action === 'resume') await ctx.scheduler.resume(args.planId, owner)
      else await ctx.scheduler.remove(args.planId, owner)
      return { planId: args.planId, action: args.action }
    },
    presentCall: args => ({ card: 'generic', kind: 'edit', title: `定时计划：${args.action}`, rawInput: args.planId }), presentResult,
  }))
  ctx.tools.register(defineTool({
    name: 'scheduler_trigger', description: 'Enqueue an immediate delivery with action start and id=planId, or request cancellation with action cancel and id=triggerId. Returns persisted trigger facts, not a promise of downstream completion. Query history to observe completion.',
    parameters: { id: text, action: { ...text, enum: ['start', 'cancel'] } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { triggerId: text, status: text } }, render: (_args, value) => [{ type: 'text', text: `Delivery ${value.triggerId}: ${value.status}. Query scheduler_query for actual state; this receipt is not downstream completion.` }] },
    execute: async (args, exec) => {
      const owner = actor(exec)
      if (args.action === 'start') {
        const trigger = await ctx.scheduler.trigger(args.id, owner)
        return { triggerId: trigger.id, status: trigger.state }
      }
      await ctx.scheduler.cancel(args.id, owner)
      return { triggerId: args.id, status: 'cancellation-requested' }
    },
    presentCall: args => ({ card: 'generic', kind: 'execute', title: `调度投递：${args.action}`, rawInput: args.id }), presentResult,
  }))
}
