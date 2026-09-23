/* oxlint-disable @stylistic/max-len */
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AuditFinding, AuditManifest, AuditState, AuditSummary, EvaluationRecord } from './types.ts'

function directory(root: string): string { return join(root, 'judgements', 'audits') }
function runDirectory(root: string, id: string): string { return join(directory(root), id) }
async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await rename(temporary, path)
}
async function atomicText(path: string, value: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, path) }
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`devflow-jev: malformed ${label}`); return value as Record<string, unknown> }
function runId(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('devflow-jev: invalid audit run id'); return value }
function checkId(value: string): string { if (!/^[0-9a-f]{20}$/.test(value)) throw new Error('devflow-jev: invalid audit check id'); return value }
function decodeManifest(value: unknown, expectedRoot: string, expectedId: string): AuditManifest { const item = record(value, 'audit manifest'); if (item.id !== expectedId || item.root !== expectedRoot || !['delivery-health', 'release', 'risk', 'spec', 'full'].includes(String(item.profile)) || typeof item.createdAt !== 'string' || typeof item.cardCount !== 'number' || !Array.isArray(item.checks)) throw new Error('devflow-jev: malformed audit manifest'); for (const raw of item.checks) { const check = record(raw, 'audit check'); if (typeof check.id !== 'string' || typeof check.cardId !== 'string' || typeof check.assessmentKind !== 'string' || typeof check.evidenceDigest !== 'string') throw new Error('devflow-jev: malformed audit check'); checkId(check.id) } return item as unknown as AuditManifest }
function decodeState(value: unknown, expectedId: string): AuditState { const item = record(value, 'audit state'); if (item.runId !== expectedId || !['planned', 'running', 'completed', 'completed-with-errors', 'cancelled', 'interrupted'].includes(String(item.status)) || typeof item.total !== 'number' || typeof item.completed !== 'number' || typeof item.failed !== 'number' || !Array.isArray(item.results) || !Array.isArray(item.findings) || typeof item.createdAt !== 'string') throw new Error('devflow-jev: malformed audit state'); return item as unknown as AuditState }
export class AuditStore {
  async create(manifest: AuditManifest, state: AuditState): Promise<void> { const dir = runDirectory(manifest.root, runId(manifest.id)); await mkdir(join(dir, 'evaluations'), { recursive: true }); await atomic(join(dir, 'manifest.json'), manifest); await atomic(join(dir, 'state.json'), state) }
  async state(root: string, id: string): Promise<AuditState> { return decodeState(await json(join(runDirectory(root, runId(id)), 'state.json')), id) }
  async manifest(root: string, id: string): Promise<AuditManifest> { return decodeManifest(await json(join(runDirectory(root, runId(id)), 'manifest.json')), root, id) }
  async writeState(root: string, state: AuditState): Promise<void> { await atomic(join(runDirectory(root, runId(state.runId)), 'state.json'), state) }
  async bindJob(root: string, id: string, jobId: string): Promise<void> { await atomic(join(runDirectory(root, runId(id)), 'job.json'), { jobId }) }
  async job(root: string, id: string): Promise<string | undefined> { try { const item = record(await json(join(runDirectory(root, runId(id)), 'job.json')), 'audit job'); if (typeof item.jobId !== 'string') throw new Error('devflow-jev: malformed audit job'); return item.jobId } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
  async writeEvaluation(root: string, id: string, check: string, evaluation: EvaluationRecord): Promise<void> { await atomic(join(runDirectory(root, runId(id)), 'evaluations', `${checkId(check)}.json`), evaluation) }
  async evaluation(root: string, id: string, check: string): Promise<EvaluationRecord | undefined> { try { const value = record(await json(join(runDirectory(root, runId(id)), 'evaluations', `${checkId(check)}.json`)), 'audit evaluation'); if (typeof value.id !== 'string' || typeof value.assessmentKind !== 'string' || typeof value.createdAt !== 'string') throw new Error('devflow-jev: malformed audit evaluation'); return value as unknown as EvaluationRecord } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
  async writeReport(root: string, id: string, findings: readonly AuditFinding[], markdown: string): Promise<void> { const dir = runDirectory(root, runId(id)); await atomic(join(dir, 'findings.json'), findings); await atomicText(join(dir, 'report.md'), markdown) }
  async inspect(root: string, id: string): Promise<AuditSummary> { const [manifest, persisted, jobId] = await Promise.all([this.manifest(root, id), this.state(root, id), this.job(root, id)]); return { manifest, state: jobId === undefined ? persisted : { ...persisted, jobId } } }
  async list(root: string): Promise<AuditSummary[]> { let entries: Dirent[]; try { entries = await readdir(directory(root), { withFileTypes: true }) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const values = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => this.inspect(root, entry.name)))
    return values.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt))
  }
}
