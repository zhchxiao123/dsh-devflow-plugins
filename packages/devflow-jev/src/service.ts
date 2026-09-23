/* oxlint-disable @stylistic/max-len */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevflowStore, DevActor } from '@zhchxiao123/dsh-devflow'
import { JevError } from '@zhchxiao123/dsh-jev'
import type { JevRuntime } from '@zhchxiao123/dsh-jev'
import { aggregate, initialState, planAudit } from './audit.ts'
import { AuditStore } from './audit-store.ts'
import { collectEvidence, evidenceDigest } from './evidence.ts'
import { assessmentRequest, decide, DEFAULT_POLICY, evidenceState, RUBRIC_VERSION } from './rubric.ts'
import type { AssessmentInput, AssessmentPolicy, AuditRequest, AuditState, AuditSummary, CardAssessmentInput, CardEvidence, EvaluationRecord, EvaluationSummary } from './types.ts'
import { summarizeEvaluation } from './types.ts'

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
  private readonly policy: AssessmentPolicy
  private readonly audits = new AuditStore()
  private readonly activeAudits = new Set<string>()
  constructor(ctx: Context, policy: AssessmentPolicy = DEFAULT_POLICY) {
    super(ctx, 'devflowJev')
    this.store = ctx.devflow
    this.judgement = ctx.jev
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
    try {
      const response = await this.judgement.ask(assessmentRequest(state, assessmentKind), signal)
      const result = decide(response.answers, this.policy, existingCard)
      record = { id, root, subject, assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'review', decision: result.decision,
        confidence: result.confidence, answers: response.answers, reasons: result.reasons, missingInformation: result.missingInformation,
        recommendedServiceClass: result.serviceClass, ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {},
        ...(response.model === undefined ? {} : { providerModel: response.model }), ...(evidence === undefined ? {} : { evidence, evidenceDigest: evidenceDigest(evidence) }), createdAt }
    } catch (error: unknown) {
      if (error instanceof JevError && error.code === 'JEV_ABORTED') throw error
      const code = error instanceof JevError ? error.code : 'JEV_UNAVAILABLE'
      record = { id, root, subject, assessmentKind, rubricVersion: RUBRIC_VERSION, status: 'unavailable', decision: 'unavailable', confidence: 0,
        answers: {}, reasons: ['The judgement provider was unavailable; no Devflow action was taken.'], missingInformation: [], recommendedServiceClass: 'standard',
        ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {}, ...(evidence === undefined ? {} : { evidence, evidenceDigest: evidenceDigest(evidence) }), error: { code, message: error instanceof Error ? error.message : String(error) }, createdAt }
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
    if (this.activeAudits.has(runId)) throw new Error(`devflow-jev: audit ${runId} is already running`)
    this.activeAudits.add(runId)
    try {
      const manifest = await this.audits.manifest(root, runId); let state = await this.audits.state(root, runId); const board = await this.store.list(undefined, root)
      const retained: AuditState['results'][number][] = []
      for (const result of state.results) {
        if (result.status !== 'completed' || result.check.rubricVersion !== RUBRIC_VERSION) continue
        const card = board.find(candidate => candidate.id === result.check.cardId)
        if (card === undefined || card.stageRevision !== result.check.stageRevision) continue
        const current = await collectEvidence(root, card, board, await this.store.history(DevflowCardId(card.id), root))
        if (evidenceDigest(current) === result.check.evidenceDigest) retained.push(result)
      }
      const { conclusion: _conclusion, ...withoutConclusion } = state
      state = { ...withoutConclusion, results: retained, completed: retained.length, failed: 0, findings: [] }
      const { finishedAt: _finishedAt, ...restartable } = state
      state = { ...restartable, status: 'running', startedAt: state.startedAt ?? new Date().toISOString() }; await this.audits.writeState(root, state)
      const evaluations: EvaluationRecord[] = []
      for (const result of state.results) if (result.status === 'completed' && result.evaluationId !== undefined) { const prior = await this.audits.evaluation(root, runId, result.check.id); if (prior !== undefined) evaluations.push(prior) }
      const completed = new Set(state.results.filter(result => result.status === 'completed').map(result => result.check.id))
      for (const check of manifest.checks) {
        if (signal?.aborted) break
        if (completed.has(check.id)) continue
        progress(`${check.cardId} ${check.assessmentKind}`)
        try {
          const card = board.find(candidate => candidate.id === check.cardId)
          if (card === undefined || card.stageRevision !== check.stageRevision) throw new Error('STALE: card stage revision changed after the audit snapshot')
          const evidence = await collectEvidence(root, card, board, await this.store.history(DevflowCardId(card.id), root))
          if (evidenceDigest(evidence) !== check.evidenceDigest) throw new Error('STALE: card evidence changed after the audit snapshot')
          const subject = { kind: 'card' as const, cardId: card.id, title: card.title, stage: card.stage, stageRevision: card.stageRevision, digest: createHash('sha256').update(`${card.id}\0${card.stageRevision}\0${card.title}\0${card.body}`).digest('hex') }
          const evaluation = await this.evaluate(root, subject, check.assessmentKind, evidenceState(evidence), true, signal, evidence)
          await this.audits.writeEvaluation(root, runId, check.id, evaluation); evaluations.push(evaluation)
          const status = evaluation.status === 'unavailable' ? 'failed' as const : 'completed' as const
          state = { ...state, completed: state.completed + 1, failed: state.failed + (status === 'failed' ? 1 : 0), results: [...state.results, { check, status, evaluationId: evaluation.id, ...(status === 'failed' ? { error: evaluation.error?.message ?? 'judgement unavailable' } : {}), completedAt: new Date().toISOString() }] }
        } catch (error: unknown) {
          if (signal?.aborted) break
          const message = error instanceof Error ? error.message : String(error); const status = message.startsWith('STALE:') ? 'stale' as const : 'failed' as const
          state = { ...state, completed: state.completed + 1, failed: state.failed + 1, results: [...state.results, { check, status, error: message, completedAt: new Date().toISOString() }] }
        }
        await this.audits.writeState(root, state)
      }
      if (signal?.aborted) state = { ...state, status: 'cancelled', finishedAt: new Date().toISOString() }
      else {
        const summary = aggregate(manifest, state, evaluations); state = { ...state, status: state.failed > 0 ? 'completed-with-errors' : 'completed', findings: summary.findings, conclusion: summary.conclusion, finishedAt: new Date().toISOString() }; await this.audits.writeReport(root, runId, summary.findings, summary.report)
      }
      await this.audits.writeState(root, state); return { manifest, state }
    } finally { this.activeAudits.delete(runId) }
  }
  async inspectAudit(root: string, runId: string): Promise<AuditSummary> {
    const summary = await this.audits.inspect(root, runId)
    if (summary.state.status !== 'running' || this.activeAudits.has(runId)) return summary
    const state: AuditState = { ...summary.state, status: 'interrupted', finishedAt: new Date().toISOString() }; await this.audits.writeState(root, state); return { manifest: summary.manifest, state }
  }
  async bindAuditJob(root: string, runId: string, jobId: string): Promise<void> { await this.audits.bindJob(root, runId, jobId) }
  async listAudits(root: string): Promise<AuditSummary[]> { const values = await this.audits.list(root); return Promise.all(values.map(async value => value.state.status === 'running' && !this.activeAudits.has(value.manifest.id) ? this.inspectAudit(root, value.manifest.id) : value)) }
  async resumeAudit(root: string, runId: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<AuditSummary> { const summary = await this.inspectAudit(root, runId); if (!['interrupted', 'cancelled', 'completed-with-errors'].includes(summary.state.status)) throw new Error(`devflow-jev: audit ${runId} cannot resume from ${summary.state.status}`); return this.runAudit(root, runId, signal, progress) }
  async list(root: string): Promise<EvaluationSummary[]> {
    let names: string[]
    try { names = await readdir(directory(root)) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = await Promise.all(names.filter(name => FILE.test(name)).map(async name => parseRecord(await readFile(join(directory(root), name), 'utf8'), name)))
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarizeEvaluation)
  }
  async read(root: string, id: string): Promise<EvaluationRecord> { return parseRecord(await readFile(pathOf(root, id), 'utf8'), id) }
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
