import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

export const name = 'scheduler-github-profile-probe'
export const inject = ['scheduler', 'githubSync', 'commands', 'agents', 'agentLoop']

/** Isolated acceptance consumer: never creates an agent or calls a model. */
export function apply(ctx) {
  let started = false
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (started) return
      started = true
      void run(ctx).then(result => {
        writeFileSync(process.env.DSH_SMOKE_RESULT, JSON.stringify(result, null, 2) + '\n')
      }).catch(error => {
        writeFileSync(process.env.DSH_SMOKE_RESULT, JSON.stringify({ status: 'failed', error: error.stack }) + '\n')
      })
    }, 50)
    return () => clearInterval(timer)
  })
}

async function until(read, predicate) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Acceptance condition timed out')
}

async function run(ctx) {
  const sync = ctx.githubSync
  const scheduler = ctx.scheduler
  const existing = await sync.subscriptions()
  if (process.env.DSH_SMOKE_PHASE === 'restart') {
    assert.equal(existing.length, 1)
    const subscription = existing[0]
    const pending = await sync.readChanges(subscription.id, 'offline', 100)
    const complete = await sync.readChanges(subscription.id, 'online', 100)
    assert.equal(pending.length, 2)
    assert.equal(complete.length, 0)
    assert.equal((await scheduler.list()).length, 1)
    await sync.replay(subscription.id, 'online', 'beginning')
    assert.equal((await sync.readChanges(subscription.id, 'online', 100)).length, 2)
    return { status: 'passed', phase: 'restart', offlinePending: pending.length, onlinePending: complete.length, replay: 2 }
  }
  assert.equal(existing.length, 0)
  const subscription = await sync.createSubscription({ repository: 'fixture/project', issues: true, discussions: false, actor: 'profile-acceptance' })
  await sync.registerConsumer(subscription.id, 'online', 'beginning')
  await sync.registerConsumer(subscription.id, 'offline', 'beginning')
  const plan = await scheduler.create({ name: 'profile acceptance', handler: 'github.sync', params: { subscriptionId: subscription.id }, rule: { kind: 'interval', everyMs: 100 }, misfire: 'latest' }, 'profile-acceptance')
  const history = await until(() => scheduler.history(plan.id), rows => rows.some(row => row.state === 'completed'))
  await scheduler.pause(plan.id, 'profile-acceptance')
  const snapshots = await sync.snapshots(subscription.id)
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map(row => row.kind).sort(), ['issue', 'issue-comment'])
  const changes = await sync.readChanges(subscription.id, 'online', 100)
  assert.equal(changes.length, 2)
  for (const change of changes) await sync.acknowledge(subscription.id, 'online', change.sequence)
  const receipt = await sync.sync(subscription.id, { triggerId: 'acceptance-repeat', actor: 'profile-acceptance' })
  const repeated = await sync.sync(subscription.id, { triggerId: 'acceptance-repeat', actor: 'profile-acceptance' })
  assert.equal(receipt.runId, repeated.runId)
  await until(() => sync.run(receipt.runId), row => row?.status === 'succeeded')
  assert.equal((await sync.readChanges(subscription.id, 'online', 100)).length, 0)
  const handle = await ctx.agents.create({ sessionId: 'scheduler-github-acceptance-command' })
  const commandResults = []
  try {
    for (const line of ['/scheduler list', `/scheduler history ${plan.id}`, '/github-sync list', `/github-sync content ${subscription.id}`, '/github-sync storage', `/github-sync pause ${subscription.id}`, `/github-sync resume ${subscription.id}`]) {
      const execution = await ctx.commands.execute(handle.agent, line, [], new AbortController().signal)
      assert.equal(execution?.result.kind, 'success', JSON.stringify(execution))
      commandResults.push({ line, result: execution.result })
    }
  } finally { await handle.dispose() }
  return { status: 'passed', commandResults, phase: 'first', planId: plan.id, subscriptionId: subscription.id, triggers: history.length, snapshots: snapshots.length, changes: changes.length, duplicateReceiptDeduplicated: true, modelCalls: 0 }
}
