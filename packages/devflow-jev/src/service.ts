/* oxlint-disable @stylistic/max-len */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevflowStore, DevActor } from '@zhchxiao123/dsh-devflow'
import { JevError } from '@zhchxiao123/dsh-jev'
import type { JevRuntime } from '@zhchxiao123/dsh-jev'
import { assessmentRequest, decide, DEFAULT_POLICY } from './rubric.ts'
import type { AssessmentInput, AssessmentPolicy, CardAssessmentInput, EvaluationRecord, EvaluationSummary } from './types.ts'
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
    return this.evaluate(input.root, subject, input.assessmentKind, { title: card.title, description: card.body, stage: card.stage, stageRevision: String(card.stageRevision), serviceClass: card.serviceClass }, true, signal)
  }
  private async evaluate(root: string, subject: EvaluationRecord['subject'], assessmentKind: EvaluationRecord['assessmentKind'], state: Readonly<Record<string, string>>, existingCard: boolean, signal?: AbortSignal): Promise<EvaluationRecord> {
    const id = randomUUID(); const createdAt = new Date().toISOString()
    let record: EvaluationRecord
    try {
      const response = await this.judgement.ask(assessmentRequest(state, assessmentKind), signal)
      const result = decide(response.answers, this.policy, existingCard)
      record = { id, root, subject, assessmentKind, rubricVersion: '1', status: 'review', decision: result.decision,
        confidence: result.confidence, answers: response.answers, reasons: result.reasons, missingInformation: result.missingInformation,
        recommendedServiceClass: result.serviceClass, ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {},
        ...(response.model === undefined ? {} : { providerModel: response.model }), createdAt }
    } catch (error: unknown) {
      if (error instanceof JevError && error.code === 'JEV_ABORTED') throw error
      const code = error instanceof JevError ? error.code : 'JEV_UNAVAILABLE'
      record = { id, root, subject, assessmentKind, rubricVersion: '1', status: 'unavailable', decision: 'unavailable', confidence: 0,
        answers: {}, reasons: ['The judgement provider was unavailable; no Devflow action was taken.'], missingInformation: [], recommendedServiceClass: 'standard',
        ...subject.kind === 'request' ? { proposedTitle: subject.title, proposedBody: subject.body } : {}, error: { code, message: error instanceof Error ? error.message : String(error) }, createdAt }
    }
    await atomicJson(pathOf(root, id), record)
    return record
  }
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
