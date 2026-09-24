/* oxlint-disable @stylistic/max-len */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { JevRunInput } from '@zhchxiao123/dsh-jev/runs-plugin'
import { Context, Service } from '@deepseek-ai/cordis'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevflowStore, DevActor } from '@zhchxiao123/dsh-devflow'
import { JevError, JevRunEngine } from '@zhchxiao123/dsh-jev'
import type { JevRuntime, JevRunResult, JevResponse } from '@zhchxiao123/dsh-jev'
import { aggregate, initialState, planAudit } from './audit.ts'
import { AuditStore } from './audit-store.ts'
import { collectEvidence, evidenceDigest } from './evidence.ts'
import { assessmentRequest, decide, DEFAULT_POLICY, evidenceState, RUBRIC_VERSION } from './rubric.ts'
import type { AssessmentInput, AssessmentPolicy, AuditRequest, AuditState, AuditSummary, AuditCheck, CardAssessmentInput, CardEvidence, EvaluationRecord, EvaluationSummary } from './types.ts'
import { ASSESSMENT_KINDS, summarizeEvaluation } from './types.ts'

declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'jev-audit': 'jev-audit' } }
export interface AssessInput { target: 'request' | 'card'; title?: string; body?: string; id?: string; assessmentKind?: EvaluationRecord['assessmentKind'] }
declare module '@deepseek-ai/cordis' { interface Context { devflowJev: DevflowJev } }
const FILE = /^[0-9a-f-]+\.json$/
const inflight = new Map<string, Promise<EvaluationRecord>>()
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function directory(root: string): string { return join(root, 'judgements', 'evaluations') }
function pathOf(root: string, id: string): string { return join(directory(root), `${id}.json`) }
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
function parseRecord(text: string, source: string): EvaluationRecord {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'id') !== 'string') throw new Error(`devflow-jev: invalid evaluation ${source}`)
  return value as EvaluationRecord
}
export class DevflowJev extends Service {
  static inject = ['devflow', 'jev']
  private readonly store: DevflowStore
  private readonly judgement: JevRuntime
  private readonly runs: JevRunEngine
  private readonly policy: AssessmentPolicy
  private readonly audits = new AuditStore()
  private readonly activeAudits = new Set<string>()
  private readonly lifecycle = new Map<string, Promise<void>>()
  async assess(root: string, input: AssessInput, signal?: AbortSignal): Promise<EvaluationRecord> {
    if (input.assessmentKind !== undefined && !ASSESSMENT_KINDS.includes(input.assessmentKind)) throw new Error('devflow-jev: invalid assessment kind')
    if (input.target === 'request') {
      if (input.id !== undefined || typeof input.title !== 'string' || !input.title.trim() || typeof input.body !== 'string' || !input.body.trim()) throw new Error('devflow-jev: request assessment requires title/body and forbids id')
      return this.assessRequest({ root, title: input.title, body: input.body, ...(input.assessmentKind === undefined ? {} : { assessmentKind: input.assessmentKind }) }, signal)
    }
    if (typeof input.id !== 'string' || !input.id.trim() || input.assessmentKind === undefined || input.title !== undefined || input.body !== undefined) throw new Error('devflow-jev: card assessment requires id/assessmentKind and forbids title/body')
    return this.assessCard({ root, cardId: input.id, assessmentKind: input.assessmentKind }, signal)
  }
  async decideJudgement(root: string, id: string, action: 'accept' | 'reject', by: DevActor): Promise<EvaluationRecord> {
    if (!/^[0-9a-f-]+$/.test(id)) throw new Error('devflow-jev: invalid evaluation id')
    return this.withOperation(root, `judgement:${id}`, () => action === 'accept' ? this.accept(root, id, by) : this.reject(root, id))
  }
  async startAudit(root: string, input: JevRunInput, owner: Agent): Promise<AuditSummary & { jobId: string }> {
    if (input.definitionJson !== undefined || input.title !== undefined || input.evidence !== undefined || input.questions !== undefined) throw new Error('devflow-jev: audits accept only profile/maxCards')
    if (input.profile !== undefined && !['delivery-health', 'release', 'risk', 'spec', 'full'].includes(input.profile)) throw new Error('devflow-jev: invalid audit profile')
    this.auditJobs()
    const prepared = await this.prepareAudit({ root, ...(input.profile === undefined ? {} : { profile: input.profile as NonNullable<AuditRequest['profile']> }), ...(input.maxCards === undefined ? {} : { maxCards: input.maxCards }) })
    return this.withOperation(root, prepared.manifest.id, async () => ({ ...prepared, jobId: await this.launchAudit(root, prepared.manifest.id, owner) }))
  }
  async controlAudit(root: string, id: string, action: 'resume' | 'cancel', owner: Agent): Promise<{ runId: string; jobId?: string; outcome?: string }> {
    const jobs = this.auditJobs()
    return this.withOperation(root, id, async () => {
      const current = await this.inspectAudit(root, id)
      if (action === 'cancel') {
        if (current.state.jobId === undefined) throw new Error('AUDIT_JOB_NOT_FOUND')
        return { runId: id, outcome: jobs.kill(JobId(current.state.jobId), owner, 'project audit cancelled') }
      }
      if (!['interrupted', 'cancelled', 'completed-with-errors'].includes(current.state.status) || this.activeAudits.has(JSON.stringify([root, id]))) throw new Error(`devflow-jev: audit ${id} cannot resume from ${current.state.status}`)
      return { runId: id, jobId: await this.launchAudit(root, id, owner) }
    })
  }
  private auditJobs() { const jobs = this.ctx.get('jobs'); if (jobs === undefined) throw new Error('JOBS_UNAVAILABLE'); return jobs }
  private async withOperation<T>(root: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([root, id]); const previous = this.lifecycle.get(key)
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => { release = resolve }); this.lifecycle.set(key, current)
    await previous
    try { return await operation() } finally { release?.(); if (this.lifecycle.get(key) === current) this.lifecycle.delete(key) }
  }
  private async launchAudit(root: string, id: string, owner: Agent): Promise<string> {
    const jobs = this.auditJobs(); const key = JSON.stringify([root, id]); this.activeAudits.add(key)
    let release: (() => void) | undefined
    const bound = new Promise<void>((resolve) => { release = resolve })
    let bindingFailed = false
    let jobId: string
    try { jobId = jobs.start({ kind: 'jev-audit', owner, label: `JEV project audit ${id}`, run: () => {
      const controller = new AbortController(); let output = ''
      const done: Promise<JobOutcome> = bound.then(async () => {
        if (bindingFailed) throw new Error('project audit job binding failed')
        return this.runAudit(root, id, controller.signal, (message) => { output = (output + message + '\n').slice(-65536) })
      }).then(value => ({ status: controller.signal.aborted ? 'killed' as const : 'completed' as const, output: JSON.stringify(value) }), (error: unknown) => ({ status: controller.signal.aborted ? 'killed' as const : 'failed' as const, output: error instanceof Error ? error.message : String(error) })).finally(() => { this.activeAudits.delete(key) })
      return { cancel: () => { controller.abort() }, done, readOutput: () => { const value = output; output = ''; return value } }
    } }) } catch (error: unknown) { this.activeAudits.delete(key); throw error }
    try { await this.bindAuditJob(root, id, jobId) } catch (error: unknown) { bindingFailed = true; jobs.kill(JobId(jobId), owner, 'project audit job binding failed'); throw error } finally { release?.() }
    return jobId
  }
  constructor(ctx: Context, policy: AssessmentPolicy = DEFAULT_POLICY) {
    super(ctx, 'devflowJev')
    this.store = ctx.devflow
    this.judgement = ctx.jev
    this.runs = new JevRunEngine(this.judgement)
    this.policy = policy
  }
  async assessRequest(input: AssessmentInput, signal?: AbortSignal): Promise<EvaluationRecord> {
    const kind = input.assessmentKind ?? 'intake'
    const subject = { kind: 'request' as const, title: input.title, body: input.body, digest: digest(`${input.title}\0${input.body}`) }
    return this.evaluate(input.root, subject, kind, { title: input.title, description: input.body }, false, signal)
  }
  async assessCard(input: CardAssessmentInput, signal?: AbortSignal): Promise<EvaluationRecord> {
    const card = await this.store.read(DevflowCardId(input.cardId), input.root)
    const subject = { kind: 'card' as const, cardId: card.id, title: card.title, stage: card.stage, stageRevision: card.stageRevision,
      digest: digest(`${card.id}\0${String(card.stageRevision)}\0${card.title}\0${card.body}`) }
    const board = await this.store.list(undefined, input.root)
    const evidence = await collectEvidence(input.root, card, board, await this.store.history(DevflowCardId(card.id), input.root))
    return this.evaluate(input.root, subject, input.assessmentKind, evidenceState(evidence), true, signal, evidence)
  }
  private async evaluate(root: string, subject: EvaluationRecord['subject'], assessmentKind: EvaluationRecord['assessmentKind'], state: Readonly<Record<string, unknown>>, existingCard: boolean, signal?: AbortSignal, evidence?: CardEvidence): Promise<EvaluationRecord> {
    const id = randomUUID(); const createdAt = new Date().toISOString()
    let record: EvaluationRecord
    const request = assessmentRequest(state, assessmentKind)
    const run = await this.runs.run({ id, scope: { kind: 'workspace', id: root, title: root }, template: { id: assessmentKind, version: RUBRIC_VERSION }, createdAt, checkTimeoutMs: this.policy.judgementDeadlineMs, checks: [{ id, subject: { kind: subject.kind, id: subject.kind === 'card' ? subject.cardId : subject.digest, title: subject.title }, evidenceDigest: evidence === undefined ? subject.digest : evidenceDigest(evidence), request }] }, undefined, {}, signal)
    if (run.status === 'cancelled') throw new JevError('dsh-jev: judgement cancelled', 'JEV_ABORTED')
    // This one-check run has no retained results. The engine supplies either
    // a response or a normalized provider error for its completed check.
    const runResult = run.results[0] as JevRunResult
    if (runResult.status === 'completed') {
      const response = runResult.response as JevResponse
      const judgementResult = decide(response.answers, this.policy, existingCard, assessmentKind)
      record = { id, root, subject, assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'review', decision: judgementResult.decision,
        confidence: judgementResult.confidence, answers: response.answers, reasons: judgementResult.reasons, missingInformation: judgementResult.missingInformation,
        recommendedServiceClass: judgementResult.serviceClass, ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {},
        ...(response.model === undefined ? {} : { providerModel: response.model }), ...(evidence === undefined ? {} : { evidence, evidenceDigest: evidenceDigest(evidence) }), createdAt }
    } else {
      const error = runResult.error as NonNullable<JevRunResult['error']>
      record = { id, root, subject, assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'unavailable', decision: 'unavailable', confidence: 0,
        answers: {}, reasons: ['The judgement provider was unavailable; no Devflow action was taken.'], missingInformation: [], recommendedServiceClass: 'standard',
        ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {}, ...(evidence === undefined ? {} : { evidence, evidenceDigest: evidenceDigest(evidence) }), error, createdAt }
    }
    await atomicJson(pathOf(root, id), record)
    return record
  }
  async prepareAudit(input: AuditRequest): Promise<AuditSummary> {
    const profile = input.profile ?? 'delivery-health'; const maxCards = input.maxCards ?? 50
    if (!Number.isInteger(maxCards) || maxCards < 1 || maxCards > 200) throw new Error('devflow-jev: maxCards must be an integer from 1 to 200')
    const { manifest } = await planAudit(this.store, input.root, profile, maxCards); const state = initialState(manifest)
    await this.audits.create(manifest, state); return { manifest, state }
  }
  async runAudit(root: string, runId: string, signal?: AbortSignal, progress: (message: string) => void = () => {}): Promise<AuditSummary> {
    const manifest = await this.audits.manifest(root, runId); const persisted = await this.audits.state(root, runId); const board = await this.store.list(undefined, root)
    const evidenceByCheck = new Map<string, CardEvidence>(); const currentDigest = new Map<string, string>()
    const snapshots: { check: AuditCheck; digest: string }[] = []
    for (const check of manifest.checks) {
      const card = board.find(candidate => candidate.id === check.cardId)
      if (card === undefined || card.stageRevision !== check.stageRevision) { const digest = `stale:${check.cardId}`; currentDigest.set(check.id, digest); snapshots.push({ check, digest }); continue }
      const evidence = await collectEvidence(root, card, board, await this.store.history(DevflowCardId(card.id), root)); evidenceByCheck.set(check.id, evidence); const digest = evidenceDigest(evidence); currentDigest.set(check.id, digest); snapshots.push({ check, digest })
    }
    const definition = { id: manifest.id, scope: { kind: 'devflow-project', id: root, title: root }, template: { id: manifest.profile, version: RUBRIC_VERSION }, createdAt: manifest.createdAt, checkTimeoutMs: this.policy.judgementDeadlineMs, checks: snapshots.map(({ check, digest }) => ({ id: check.id, subject: { kind: 'devflow-card', id: check.cardId, title: check.cardTitle }, evidenceDigest: digest, request: assessmentRequest(evidenceState(evidenceByCheck.get(check.id) ?? { card: { id: check.cardId, title: check.cardTitle, body: '', stage: check.stage, stageRevision: check.stageRevision, serviceClass: 'standard' }, journal: [], artifacts: [], gaps: [{ kind: 'unreadable', path: check.cardId, detail: 'card changed after audit planning' }], relations: { children: [] } }), check.assessmentKind) })) }
    const priorResults: JevRunResult[] = []; const evaluations: EvaluationRecord[] = []
    for (const result of persisted.results) {
      if (result.status !== 'completed' || result.evaluationId === undefined) continue
      const evaluation = await this.audits.evaluation(root, runId, result.check.id); if (evaluation === undefined) continue
      if (result.check.evidenceDigest === currentDigest.get(result.check.id)) evaluations.push(evaluation)
      priorResults.push({ checkId: result.check.id, subject: { kind: 'devflow-card', id: result.check.cardId, title: result.check.cardTitle }, evidenceDigest: result.check.evidenceDigest, status: 'completed' as const, response: { answers: evaluation.answers, ...(evaluation.providerModel === undefined ? {} : { model: evaluation.providerModel }) }, completedAt: result.completedAt })
    }
    const previous = { runId, status: persisted.status, total: persisted.total, completed: priorResults.length, failed: 0, results: priorResults, createdAt: persisted.createdAt, ...(persisted.startedAt === undefined ? {} : { startedAt: persisted.startedAt }), ...(persisted.jobId === undefined ? {} : { jobId: persisted.jobId }) }
    const retained = persisted.results.filter(result => priorResults.some(prior => prior.checkId === result.check.id && prior.evidenceDigest === currentDigest.get(prior.checkId)))
    let state: AuditState = { ...persisted, results: retained, completed: retained.length, failed: 0, findings: [] }
    const generic = await this.runs.run(definition, previous, {
      onState: async (current) => { state = { ...state, status: current.status, startedAt: current.startedAt as string }; await this.audits.writeState(root, state) },
      // The engine only calls these hooks for checks from this definition.
      validate: (check) => { const planned = manifest.checks.find(item => item.id === check.id) as AuditCheck; if (!evidenceByCheck.has(check.id) || check.evidenceDigest !== planned.evidenceDigest) throw new Error('STALE: card evidence changed after the audit snapshot'); progress(`${planned.cardId} ${planned.assessmentKind}`) },
      onResult: async (result) => {
        const check = manifest.checks.find(item => item.id === result.checkId) as AuditCheck
        if (result.status === 'completed') {
          // Completion follows successful validation of the collected evidence.
          const evidence = evidenceByCheck.get(check.id) as CardEvidence
          const response = result.response as JevResponse
          const subject = { kind: 'card' as const, cardId: evidence.card.id, title: evidence.card.title, stage: evidence.card.stage, stageRevision: evidence.card.stageRevision, digest: digest(`${evidence.card.id}\0${String(evidence.card.stageRevision)}\0${evidence.card.title}\0${evidence.card.body}`) }
          const judgementResult = decide(response.answers, this.policy, true, check.assessmentKind); const evaluation: EvaluationRecord = { id: randomUUID(), root, subject, assessmentKind: check.assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'review', decision: judgementResult.decision, confidence: judgementResult.confidence, answers: response.answers, reasons: judgementResult.reasons, missingInformation: judgementResult.missingInformation, recommendedServiceClass: judgementResult.serviceClass, ...(response.model === undefined ? {} : { providerModel: response.model }), evidence, evidenceDigest: evidenceDigest(evidence), createdAt: result.completedAt }
          await atomicJson(pathOf(root, evaluation.id), evaluation); await this.audits.writeEvaluation(root, runId, check.id, evaluation); evaluations.push(evaluation); state = { ...state, completed: state.completed + 1, results: [...state.results, { check, status: 'completed', evaluationId: evaluation.id, completedAt: result.completedAt }] }
        } else {
          const error = result.error as NonNullable<JevRunResult['error']>
          const stale = error.message.startsWith('STALE:')
          if (!stale) {
            const evidence = evidenceByCheck.get(check.id) as CardEvidence
            const subject = { kind: 'card' as const, cardId: evidence.card.id, title: evidence.card.title, stage: evidence.card.stage, stageRevision: evidence.card.stageRevision, digest: digest(`${evidence.card.id}\0${String(evidence.card.stageRevision)}\0${evidence.card.title}\0${evidence.card.body}`) }
            const errorMessage = error.message; const evaluation: EvaluationRecord = { id: randomUUID(), root, subject, assessmentKind: check.assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'unavailable', decision: 'unavailable', confidence: 0, answers: {}, reasons: ['The judgement provider was unavailable; no Devflow action was taken.'], missingInformation: [], recommendedServiceClass: 'standard', evidence, evidenceDigest: evidenceDigest(evidence), error, createdAt: result.completedAt }
            await atomicJson(pathOf(root, evaluation.id), evaluation); await this.audits.writeEvaluation(root, runId, check.id, evaluation); evaluations.push(evaluation); state = { ...state, completed: state.completed + 1, failed: state.failed + 1, results: [...state.results, { check, status: 'failed', evaluationId: evaluation.id, error: errorMessage, completedAt: result.completedAt }] }
          } else state = { ...state, completed: state.completed + 1, failed: state.failed + 1, results: [...state.results, { check, status: 'stale', error: error.message, completedAt: result.completedAt }] }
        }
        await this.audits.writeState(root, state)
      },
    }, signal)
    // The engine awaits onResult for every fresh result; retained checkpoints
    // were loaded above. There is no second result-reconciliation write path.
    state = { ...state, status: generic.status, startedAt: generic.startedAt as string, finishedAt: generic.finishedAt as string }
    if (generic.status !== 'cancelled') { const summary = aggregate(manifest, state, evaluations); state = { ...state, findings: summary.findings, conclusion: summary.conclusion }; await this.audits.writeReport(root, runId, summary.findings, summary.report) }
    await this.audits.writeState(root, state); return { manifest, state }
  }
  async inspectAudit(root: string, runId: string): Promise<AuditSummary> {
    const summary = await this.audits.inspect(root, runId)
    const recovered = this.runs.recover({ runId, status: summary.state.status, total: summary.state.total, completed: summary.state.completed, failed: summary.state.failed, results: [], createdAt: summary.state.createdAt, ...(summary.state.jobId === undefined ? {} : { jobId: summary.state.jobId }) }, { active: this.runs.isActive(runId) || this.activeAudits.has(JSON.stringify([root, runId])) })
    if (recovered.status === summary.state.status) return summary
    const state: AuditState = { ...summary.state, status: recovered.status, finishedAt: recovered.finishedAt as string }; await this.audits.writeState(root, state); return { manifest: summary.manifest, state }
  }
  async bindAuditJob(root: string, runId: string, jobId: string): Promise<void> { await this.audits.bindJob(root, runId, jobId) }
  async listAudits(root: string): Promise<AuditSummary[]> { const values = await this.audits.list(root); return Promise.all(values.map(async value => ['planned', 'running'].includes(value.state.status) && !this.runs.isActive(value.manifest.id) ? this.inspectAudit(root, value.manifest.id) : value)) }
  async resumeAudit(root: string, runId: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<AuditSummary> { const summary = await this.inspectAudit(root, runId); if (!['interrupted', 'cancelled', 'completed-with-errors'].includes(summary.state.status)) throw new Error(`devflow-jev: audit ${runId} cannot resume from ${summary.state.status}`); return this.runAudit(root, runId, signal, progress) }
  async list(root: string): Promise<EvaluationSummary[]> {
    let names: string[]
    try { names = await readdir(directory(root)) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = await Promise.all(names.filter(name => FILE.test(name)).map(async name => parseRecord(await readFile(join(directory(root), name), 'utf8'), name)))
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarizeEvaluation)
  }
  async read(root: string, id: string): Promise<EvaluationRecord> { if (!/^[0-9a-f-]+$/.test(id)) throw new Error('devflow-jev: invalid evaluation id'); return parseRecord(await readFile(pathOf(root, id), 'utf8'), id) }
  async accept(root: string, id: string, by: DevActor): Promise<EvaluationRecord> {
    const key = `${root}\0${id}`; const current = inflight.get(key); if (current !== undefined) return current
    const operation = this.acceptOnce(root, id, by).finally(() => { inflight.delete(key) })
    inflight.set(key, operation); return operation
  }
  private async acceptOnce(root: string, id: string, by: DevActor): Promise<EvaluationRecord> {
    const record = await this.read(root, id)
    if (record.status === 'created') return record
    if (record.status !== 'review' || record.decision !== 'propose' || record.proposedTitle === undefined || record.proposedBody === undefined) throw new Error(`devflow-jev: evaluation ${id} is not an actionable proposal`)
    // Recover the narrow crash window after the card commit but before this
    // evaluation's state write. The marker is part of the durable card body,
    // so a new process can prove the action already happened.
    const marker = `Source evaluation: ${record.id}`
    const existing = (await this.store.list(undefined, root)).find(card => card.body.includes(marker))
    if (existing !== undefined) {
      const recovered: EvaluationRecord = {
        ...record, status: 'created', createdCardId: existing.id, decidedAt: new Date().toISOString(),
      }
      await atomicJson(pathOf(root, id), recovered)
      return recovered
    }
    const created = await this.store.create(this.store.resolveCreate({ root, title: record.proposedTitle, body: `${record.proposedBody}\n\n## Judgement\n\nSource evaluation: ${record.id}\n`, serviceClass: record.recommendedServiceClass, by }))
    if (!created.ok) throw new Error(created.message)
    const next: EvaluationRecord = { ...record, status: 'created', createdCardId: created.card.id, decidedAt: new Date().toISOString() }
    await atomicJson(pathOf(root, id), next); return next
  }
  async reject(root: string, id: string): Promise<EvaluationRecord> {
    const record = await this.read(root, id)
    if (record.status === 'created') throw new Error(`devflow-jev: evaluation ${id} already created card ${record.createdCardId ?? ''}`)
    if (record.status === 'rejected') return record
    const next: EvaluationRecord = { ...record, status: 'rejected', decidedAt: new Date().toISOString() }
    await atomicJson(pathOf(root, id), next); return next
  }
}
