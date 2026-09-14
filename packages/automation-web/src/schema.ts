/** Schemas validate only wire boundaries; services retain all domain policy. */
import { z } from 'zod'
const id = z.string().min(1).max(256)
const number = z.number()
const optionalNumber = number.optional()
const text = z.string()
const optionalText = text.optional()
const rule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), everyMs: number.int().positive() }),
  z.strictObject({ kind: z.literal('cron'), expression: id, timezone: id }),
])
const planInput = z.strictObject({ name: id, handler: id, params: z.json(), rule,
  misfire: z.enum(['latest',
    'skip']).optional(),
  maxAttempts: number.int().positive().optional(),
  timeoutMs: number.int().positive().optional() })
const subscriptionInput = z.strictObject({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issues: z.boolean(),
  discussions: z.boolean(),
  credentialRef: z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/).optional() })
export const requestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('overview') }),
  z.strictObject({ method: z.literal('content'), subscriptionId: id }),
  z.strictObject({ method: z.literal('plan.save'), id: id.optional(), input: planInput }),
  z.strictObject({ method: z.literal('plan.action'), id, action: z.enum(['pause', 'resume', 'remove', 'trigger', 'cancel']) }),
  z.strictObject({ method: z.literal('subscription.save'), id: id.optional(), input: subscriptionInput }),
  z.strictObject({ method: z.literal('subscription.action'), id, action: z.enum(['pause', 'resume', 'sync']) }),
  z.strictObject({ method: z.literal('run.action'), id, action: z.enum(['cancel', 'resume']) }),
  z.strictObject({ method: z.literal('capacity.set'), bytes: number.int().positive() }),
])
/** Response shapes preserve service values; admission limits belong only to requests. */
const returnedRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), everyMs: number }),
  z.object({ kind: z.literal('cron'), expression: text, timezone: text }),
])
const plan = z.object({ id: text, name: text, handler: text, params: z.json(), rule: returnedRule,
  misfire: z.enum(['latest', 'skip']).optional(), maxAttempts: optionalNumber, timeoutMs: optionalNumber,
  enabled: z.boolean(), deleted: z.boolean(), nextAt: number, createdBy: text, updatedBy: text })
const trigger = z.object({ id: text,
  planId: text,
  scheduledAt: number,
  state: z.enum(['pending',
    'delivering',
    'accepted',
    'completed',
    'failed',
    'cancelled',
    'partial']),
  attempts: number,
  runId: optionalText,
  error: optionalText,
  acceptedAt: optionalNumber,
  completedAt: optionalNumber,
  requestedBy: text })
const subscription = z.object({ id: text,
  repository: text,
  credentialRef: optionalText,
  issues: z.boolean(),
  discussions: z.boolean(),
  actor: text,
  paused: z.boolean(),
  revision: number,
  lastSuccessAt: optionalNumber,
  lastReconcileAt: optionalNumber })
const run = z.object({ subscriptionSnapshot: subscription,
  id: text,
  subscriptionId: text,
  triggerId: text,
  actor: text,
  acceptedAt: number,
  status: z.enum(['queued',
    'running',
    'waiting',
    'succeeded',
    'partial',
    'failed',
    'cancelled']),
  checkpointSequence: number,
  pageBudget: number,
  pages: number,
  objects: number,
  retries: number,
  fence: number,
  leaseUntil: number,
  owner: text,
  reconcile: z.boolean(),
  completedAt: optionalNumber,
  error: optionalText,
  waitUntil: optionalNumber })
const snapshot = z.object({ id: text,
  subscriptionId: text,
  kind: z.enum(['issue',
    'issue-comment',
    'discussion',
    'discussion-comment',
    'discussion-reply']),
  parentId: optionalText,
  url: text,
  updatedAt: text,
  title: text,
  body: text,
  state: text,
  version: number,
  fingerprint: text,
  fetchedAt: number,
  deleted: z.boolean() })
const storage = z.object({ bytes: number,
  capacityBytes: number,
  blocked: z.boolean(),
  error: optionalText,
  capacityChangedBy: optionalText,
  capacityChangedAt: optionalNumber })
const receipt = z.object({ runId: text, acceptedAt: number })
export const results = {
  overview: z.object({ schedulerAvailable: z.boolean(),
    githubAvailable: z.boolean(),
    plans: z.array(plan),
    triggers: z.array(trigger),
    subscriptions: z.array(subscription),
    runs: z.array(run),
    storage: storage.nullable() }),
  content: z.array(snapshot),
  'plan.save': plan,
  'plan.action': trigger.nullable(),
  'subscription.save': subscription,
  'subscription.action': z.union([subscription, receipt]),
  'run.action': receipt.nullable(),
  'capacity.set': storage,
}
export const envelopeSchema = z.discriminatedUnion('ok',
  [z.object({ ok: z.literal(true),
    data: z.unknown() }),
  z.object({ ok: z.literal(false),
    error: text })])
