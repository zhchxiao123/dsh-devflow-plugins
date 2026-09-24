/* oxlint-disable @stylistic/max-len */
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { JevRunDefinition, JevRunHooks, JevRunState } from './runs.ts'
import { initialJevRunState, JevRunEngine } from './runs.ts'

export interface JevRunSnapshot { readonly definition: JevRunDefinition; readonly state: JevRunState }
function id(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) throw new Error('dsh-jev: invalid run id'); return value }
function directory(root: string): string { return join(root, 'runs') }
function runDirectory(root: string, runId: string): string { return join(directory(root), id(runId)) }
async function atomic(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); await rename(temporary, path) }
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown }
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`dsh-jev: malformed ${label}`); return value as Record<string, unknown> }
function definition(value: unknown, expectedId: string): JevRunDefinition { const item = object(value, 'run definition'); if (item.id !== expectedId || typeof item.createdAt !== 'string' || !Array.isArray(item.checks)) throw new Error('dsh-jev: malformed run definition'); if (item.checkTimeoutMs !== undefined && (typeof item.checkTimeoutMs !== 'number' || !Number.isFinite(item.checkTimeoutMs) || item.checkTimeoutMs <= 0)) throw new Error('dsh-jev: malformed run definition'); const scope = object(item.scope, 'run scope'); const template = object(item.template, 'run template'); if (typeof scope.kind !== 'string' || typeof scope.id !== 'string' || typeof scope.title !== 'string' || typeof template.id !== 'string' || typeof template.version !== 'string') throw new Error('dsh-jev: malformed run definition'); const ids = new Set<string>(); for (const raw of item.checks) { const check = object(raw, 'run check'); const subject = object(check.subject, 'run check subject'); const request = object(check.request, 'run check request'); if (typeof check.id !== 'string' || ids.has(check.id) || typeof check.evidenceDigest !== 'string' || typeof subject.kind !== 'string' || typeof subject.id !== 'string' || typeof subject.title !== 'string' || !('state' in request) || request.questions === null || typeof request.questions !== 'object' || Array.isArray(request.questions)) throw new Error('dsh-jev: malformed run check'); ids.add(check.id) } return item as unknown as JevRunDefinition }
function state(value: unknown, expectedId: string): JevRunState { const item = object(value, 'run state'); if (item.runId !== expectedId || !['planned', 'running', 'completed', 'completed-with-errors', 'cancelled', 'interrupted'].includes(String(item.status)) || typeof item.total !== 'number' || typeof item.completed !== 'number' || typeof item.failed !== 'number' || !Array.isArray(item.results) || typeof item.createdAt !== 'string') throw new Error('dsh-jev: malformed run state'); return item as unknown as JevRunState }

/** Filesystem adapter for generic JEV runs. The root is chosen by the caller and has no Devflow meaning. */
export class FileJevRunStore {
  async create(root: string, value: JevRunDefinition): Promise<JevRunSnapshot> { const validated = definition(value, id(value.id)); const initial = initialJevRunState(validated); await mkdir(directory(root), { recursive: true }); await mkdir(runDirectory(root, validated.id)); await atomic(join(runDirectory(root, validated.id), 'definition.json'), validated); await atomic(join(runDirectory(root, validated.id), 'state.json'), initial); return { definition: validated, state: initial } }
  async writeState(root: string, value: JevRunState): Promise<void> { await atomic(join(runDirectory(root, value.runId), 'state.json'), value) }
  async bindJob(root: string, runId: string, jobId: string): Promise<void> { await atomic(join(runDirectory(root, id(runId)), 'job.json'), { jobId }) }
  private async job(root: string, runId: string): Promise<string | undefined> { try { const value = object(await json(join(runDirectory(root, id(runId)), 'job.json')), 'run job'); if (typeof value.jobId !== 'string') throw new Error('dsh-jev: malformed run job'); return value.jobId } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
  async read(root: string, runId: string): Promise<JevRunSnapshot> { const safe = id(runId); const [rawDefinition, rawState, jobId] = await Promise.all([json(join(runDirectory(root, safe), 'definition.json')), json(join(runDirectory(root, safe), 'state.json')), this.job(root, safe)]); const persisted = state(rawState, safe); return { definition: definition(rawDefinition, safe), state: jobId === undefined ? persisted : { ...persisted, jobId } } }
  async list(root: string): Promise<JevRunSnapshot[]> { let entries: Dirent[]; try { entries = await readdir(directory(root), { withFileTypes: true }) } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } const values = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => this.read(root, entry.name))); return values.sort((a, b) => b.definition.createdAt.localeCompare(a.definition.createdAt)) }
}

/** Durable generic run interface used by adapters, tools, schedulers, and UIs. */
export class DurableJevRuns {
  constructor(private readonly engine: JevRunEngine, private readonly store = new FileJevRunStore()) {}
  prepare(root: string, definition: JevRunDefinition): Promise<JevRunSnapshot> { return this.store.create(root, definition) }
  bindJob(root: string, runId: string, jobId: string): Promise<void> { return this.store.bindJob(root, runId, jobId) }
  async execute(root: string, runId: string, hooks: JevRunHooks = {}, signal?: AbortSignal): Promise<JevRunSnapshot> { const current = await this.store.read(root, runId); const next = await this.engine.run(current.definition, current.state, { ...hooks, onState: async (value) => { await this.store.writeState(root, value); await hooks.onState?.(value) } }, signal); return { definition: current.definition, state: next } }
  async inspect(root: string, runId: string): Promise<JevRunSnapshot> { const current = await this.store.read(root, runId); const recovered = this.engine.recover(current.state); if (recovered !== current.state) await this.store.writeState(root, recovered); return { definition: current.definition, state: recovered } }
  async list(root: string): Promise<JevRunSnapshot[]> { const values = await this.store.list(root); return Promise.all(values.map(value => this.inspect(root, value.definition.id))) }
}
