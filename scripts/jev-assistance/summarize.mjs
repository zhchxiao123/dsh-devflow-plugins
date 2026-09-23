/** Offline evidence extraction only: no model calls and no fixture/session mutation. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ? resolve(process.argv[2]) : import.meta.dirname
const expectedAcceptanceSha256 = '9e73741aac0c4494cd7308b4aff21f116451392b8d0c498c835b56b00e76a8e7'
const sha = value => createHash('sha256').update(value).digest('hex')
const optionalJson = path => readFile(path, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
function signature(name, args) {
  const semantic = name === 'bash' ? { command: args.command, workdir: args.workdir ?? '' } : args
  return sha(JSON.stringify([name, stable(semantic)]))
}
async function sessionFiles(path) {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await sessionFiles(join(path, entry.name)))
    else if (entry.name.endsWith('.jsonl.zstd')) files.push(join(path, entry.name))
  }
  return files
}
async function loadSession(path) {
  const files = await sessionFiles(path)
  if (files.length !== 1) throw new Error(`Expected one session log, found ${files.length}: ${path}`)
  const bytes = await readFile(files[0]); let remaining = bytes; const events = []
  while (remaining.length) {
    const decoded = zstdDecompressSync(remaining, { info: true })
    if (!decoded.engine.bytesWritten) throw new Error('Zstandard decoder made no progress')
    events.push(...decoded.buffer.toString().split('\n').filter(Boolean).map(JSON.parse))
    remaining = remaining.subarray(decoded.engine.bytesWritten)
  }
  return { events, file: relative(root, files[0]), sha256: sha(bytes) }
}
function operations(events, fixture) {
  const callEvents = events.filter(event => event.type === 'tool/call')
  const calls = new Map(callEvents.map(event => [event.data.callId, event]))
  if (calls.size !== callEvents.length) throw new Error('Duplicate tool call IDs in session ledger')
  const result = []; const completedCallIds = new Set()
  for (const event of events.filter(item => item.type === 'tool/result')) {
    for (const block of event.data.message.content.filter(item => item.type === 'tool-result')) {
      const call = calls.get(block.toolCallId)
      if (!call) throw new Error(`Result has no matching call: ${block.toolCallId}`)
      if (completedCallIds.has(block.toolCallId)) throw new Error('Duplicate tool result in session ledger')
      if (typeof block.isError !== 'boolean') throw new Error('Tool result lacks a trustworthy error indicator')
      completedCallIds.add(block.toolCallId)
      const args = JSON.parse(call.data.arguments)
      const command = typeof args.command === 'string' ? args.command : ''
      const output = block.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      const exitMarker = /\[exit code: (-?\d+)\]\s*$/.exec(output)
      const reportedFailure = block.isError || Boolean(exitMarker && Number(exitMarker[1]) !== 0)
      const verification = call.data.name === 'bash' && (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnode\s+--test\b/.test(command) || /\bnode\b/.test(command) && /TaskStore|acceptance\.mjs|repro|crossproc/.test(command))
      const negativeControl = verification && /git show HEAD:store\.mjs|store\.old\.mjs|old-store\.mjs/.test(command)
      const failureLines = verification ? output.split('\n').filter(line => /^\s*(?:✖|not ok\b|(?:ℹ|#) fail\s+[1-9]|(?:AssertionError|TypeError|SyntaxError|Error)(?: \[[A-Z_]+\])?:)/.test(line)) : []
      const verificationFailed = verification && !negativeControl && (reportedFailure || failureLines.length > 0)
      const suppliedPath = args.file_path ?? args.path
      const target = typeof suppliedPath === 'string' ? relative(fixture, resolve(fixture, suppliedPath)) : undefined
      const mutation = ['write', 'edit', 'apply_patch'].includes(call.data.name) && !reportedFailure && target !== undefined && !isAbsolute(target) && !target.startsWith('..') && !target.split('/').some(part => part.startsWith('.'))
      result.push({ seq: call.seq, resultSeq: event.seq, step: call.data.step, callId: call.data.callId, name: call.data.name, signature: signature(call.data.name, args), reportedFailure, verification, negativeControl, verificationFailed, mutation, target, failureLines: failureLines.slice(0, 4), commandDigest: command ? sha(command) : undefined })
    }
  }
  if (result.length !== calls.size) throw new Error('Incomplete tool-call/result ledger; metrics would be unknown')
  return result.sort((a, b) => a.seq - b.seq)
}
function derive(ops) {
  const failureBySignature = new Map(); const firstMutationStep = new Map()
  const mutationSteps = new Set(); const rewriteSteps = new Set(); const afterFailureSteps = new Set()
  const repeatedFailurePairs = []; const failedVerificationRepairs = []; let pendingFailure; let mutatedAfterFailure = false
  for (const op of ops) {
    if (op.mutation) {
      mutationSteps.add(op.step)
      if (firstMutationStep.has(op.target) && firstMutationStep.get(op.target) < op.step) rewriteSteps.add(op.step)
      if (!firstMutationStep.has(op.target)) firstMutationStep.set(op.target, op.step)
      if (pendingFailure) { afterFailureSteps.add(op.step); mutatedAfterFailure = true }
      failureBySignature.clear()
    }
    const failed = !op.negativeControl && (op.reportedFailure || op.verificationFailed)
    if (failed) {
      const prior = failureBySignature.get(op.signature)
      if (prior) repeatedFailurePairs.push({ prior: prior.callId, current: op.callId, priorSeq: prior.seq, currentSeq: op.seq, controlled: Boolean(prior.controlled || op.controlled) })
      failureBySignature.set(op.signature, op)
    } else failureBySignature.delete(op.signature)
    if (op.verification && !op.negativeControl) {
      if (pendingFailure && pendingFailure.signature !== op.signature && !op.verificationFailed && !mutatedAfterFailure) failedVerificationRepairs.push({ failedCall: pendingFailure.callId, retryCall: op.callId, failedSeq: pendingFailure.seq, retrySeq: op.seq })
      if (op.verificationFailed) { pendingFailure = op; mutatedAfterFailure = false }
      else { pendingFailure = undefined; mutatedAfterFailure = false }
    }
  }
  return { reportedToolFailures: ops.filter(op => op.reportedFailure).length, currentVerificationFailures: ops.filter(op => op.verificationFailed).length, negativeControlRuns: ops.filter(op => op.negativeControl).length, sameSignatureFailureRepeatsWithoutMutation: repeatedFailurePairs.length, repeatedFailurePairs, mutationRounds: mutationSteps.size, subsequentRewriteRounds: rewriteSteps.size, rewriteSteps: [...rewriteSteps], mutationRoundsAfterFailedVerification: afterFailureSteps.size, afterFailureSteps: [...afterFailureSteps], changedVerificationCommandRecoveries: failedVerificationRepairs.length, failedVerificationRepairs }
}
const rows = []
for (const stamp of (await readdir(join(root, 'runs'))).sort()) {
  const base = join(root, 'runs', stamp)
  const experiment = await optionalJson(join(base, 'experiment.json'))
  if (!experiment) continue
  for (const mode of ['off', 'observe', 'assist']) {
    const metrics = await optionalJson(join(base, mode + '-metrics.json'))
    if (metrics?.outcome !== 'completed') continue
    const events = await optionalJson(join(base, mode + '-events.json'))
    const directJevToolCalls = events.filter(event => event.type === 'tool/result' && (event.tool === 'devflow_assess' || event.tool.startsWith('jev_'))).length
    const dir = join(base, mode, '.devflow/judgements/assistance')
    const records = await Promise.all((await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error })).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(dir, name), 'utf8'))))
    if (!Array.isArray(metrics.assistanceStatuses) || records.length !== metrics.assistanceStatuses.length || JSON.stringify(records.map(record => record.status).sort()) !== JSON.stringify([...metrics.assistanceStatuses].sort())) throw new Error('Assistance record ledger differs from completed-run metrics; intervention counts are unknown')
    const session = await loadSession(join(base, mode + '-home/sessions'))
    const recordedWorkspace = session.events.find(event => event.type === 'session')?.cwd
    if (typeof recordedWorkspace !== 'string') throw new Error('Session workspace identity is missing')
    const ops = operations(session.events, recordedWorkspace)
    const controlledFailures = await optionalJson(join(base, mode + '-controlled-failures.json')) ?? []
    if (experiment.scenario === 'contract-failure' && (controlledFailures.length !== 2 || controlledFailures.some(failure => typeof failure.callId !== 'string' || !Number.isInteger(failure.exitCode) || failure.exitCode === 0 || typeof failure.output !== 'string'))) throw new Error('Controlled failure evidence is missing or malformed; failure counts are unknown')
    if (controlledFailures.length) {
      const boundary = session.events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes('Controlled integration fixture:'))
      if (!boundary) throw new Error('Controlled results have no matching public-hook message')
      for (const [index, failure] of controlledFailures.entries()) ops.push({ seq: null, orderingPosition: boundary.seq - 1 + (index + 1) / (controlledFailures.length + 1), beforeMessageSeq: boundary.seq, step: 2, callId: failure.callId, name: 'bash', signature: signature('bash', { command: 'node --test store.test.mjs' }), controlled: true, reportedFailure: failure.exitCode !== 0, verification: true, verificationFailed: failure.exitCode !== 0, negativeControl: false, mutation: false, failureLines: failure.output.split('\n').filter(line => /TypeError|AssertionError|SyntaxError/.test(line)).slice(0, 2) })
      ops.sort((a, b) => (a.orderingPosition ?? a.seq) - (b.orderingPosition ?? b.seq))
    }
    const acceptanceSource = await readFile(join(base, 'acceptance.mjs'))
    const acceptanceSha256 = sha(acceptanceSource)
    const unchangedAcceptance = acceptanceSha256 === expectedAcceptanceSha256
    const acceptedAssertions = unchangedAcceptance && metrics.acceptance.passed ? 10 : null
    const verifierReads = session.events.filter(event => event.type === 'tool/call' && event.data.name === 'read' && /(?:acceptance\.mjs|experiment\.json)/.test(event.data.arguments)).map(event => ({ seq: event.seq, callId: event.data.callId }))
    const delivered = records.filter(record => record.status === 'delivered')
    const deliveredAudits = delivered.map(record => {
      // A manual review rule for the one retained controlled sample; future advice is not assumed correct.
      const known = stamp === '2026-09-23T09-16-06-783Z' && record.id === '52f8d320-8666-43ab-8dc4-ce5f8995b601'
      const actualMessage = session.events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes(record.id))
      const after = actualMessage ? ops.filter(op => op.seq > actualMessage.seq && !op.controlled) : []
      const reviewCriteria = { twoActualFailures: controlledFailures.length === 2 && controlledFailures.every(item => item.exitCode !== 0), actualDeliveryMessage: Boolean(actualMessage), subsequentRead: after.some(op => op.name === 'read'), withinSteerBudget: delivered.length <= experiment.budgets.extraSteersPerTurn, independentAcceptancePassed: metrics.acceptance.passed }
      const reviewed = known && record.action === 'read-evidence' && Object.values(reviewCriteria).every(Boolean)
      return { id: record.id, reviewCriteria, classification: reviewed ? 'no-observable-misintervention-under-stated-review-criteria' : 'not-reviewed', falseIntervention: reviewed ? false : null, triggerCalls: known ? controlledFailures.map(item => item.callId) : [], deliveryMessageSeq: actualMessage?.seq ?? null, subsequentReadSeqs: after.filter(op => op.name === 'read').map(op => op.seq), subsequentMutationSeqs: after.filter(op => op.mutation).map(op => op.seq), outcome: record.outcome, outcomeDetail: record.outcomeDetail ?? null, causalNecessity: 'not-established' }
    })
    const falseCount = deliveredAudits.every(audit => audit.falseIntervention !== null) ? deliveredAudits.filter(audit => audit.falseIntervention).length : null
    rows.push({ stamp, sampleClass: experiment.scenario === 'contract-failure' ? 'controlled-contract' : stamp === '2026-09-23T08-52-40-890Z' ? 'preparation' : 'natural', scenario: experiment.scenario ?? 'feature', mode, elapsedMs: metrics.elapsedMs, steps: metrics.steps, toolFailures: metrics.toolFailures, directJevToolCalls, acceptance: metrics.acceptance.passed, remoteJudgments: records.filter(record => record.model !== undefined).length, recordCount: records.length, delivered: delivered.length, jevElapsedMs: metrics.assistanceElapsedMs, policyVersions: [...new Set(records.map(record => record.policyVersion))], sourceDigests: experiment.sourceDigests ?? null, provider: metrics.provider, model: metrics.model, jevModels: [...new Set(records.flatMap(record => record.model ? [record.model] : []))], inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, currencyCost: null, judgments: records.map(record => ({ id: record.id, event: record.event, status: record.status, action: record.action, confidence: record.confidence, actionConfidence: record.actionConfidence ?? null, justifiedProbability: record.justifiedProbability ?? null, outcome: record.outcome, outcomeDetail: record.outcomeDetail ?? null })), operationalMetrics: derive(ops), operationalEvidence: { sessionFile: session.file, sessionSha256: session.sha256, sessionEventCount: session.events.length, matchedSessionToolResults: ops.filter(op => !op.controlled).length, controlledFailureCount: controlledFailures.length, operations: ops }, acceptanceAudit: { acceptanceSha256, expectedAcceptanceSha256, unchangedAcceptance, explicitAssertionsPassed: acceptedAssertions, explicitAssertionsTotal: 10, verifierReads, blinded: false, limits: ['Repeated archive has no immediate post-repeat state assertion.', 'Missing-id error assertions check nonempty messages, not semantic clarity.', 'Read access was not sandboxed; independent execution is not a blinded evaluation.'] }, misinterventionAudit: { delivered: delivered.length, falseInterventionCount: falseCount, falseInterventionRate: delivered.length && falseCount !== null ? falseCount / delivered.length : null, rateLabel: delivered.length ? 'limited observable-criteria audit, not causal efficacy' : 'N/A: no delivered advice', records: deliveredAudits } })
  }
}
await writeFile(join(root, 'results.json'), JSON.stringify(rows, null, 2))
console.log(rows.filter(row => row.sampleClass !== 'preparation').map(row => ({ run: row.stamp, mode: row.mode, seconds: row.elapsedMs / 1000, ...row.operationalMetrics, assertionCoverage: `${row.acceptanceAudit.explicitAssertionsPassed}/${row.acceptanceAudit.explicitAssertionsTotal}`, falseInterventions: row.misinterventionAudit.falseInterventionCount, falseInterventionRate: row.misinterventionAudit.falseInterventionRate })))
