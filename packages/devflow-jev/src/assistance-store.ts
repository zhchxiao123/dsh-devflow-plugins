/** Atomic advice records; the Devflow journal remains the sole stage authority. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssistanceRecord } from './assistance-types.ts'

const ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/
const statuses = ['observed', 'delivering', 'delivered', 'stale', 'cancelled', 'unavailable', 'budget-exhausted']
function valid(value: unknown): value is AssistanceRecord {
  if (typeof value !== 'object' || value === null) return false
  const get = (key: string): unknown => Reflect.get(value, key)
  if (!['id', 'workspace', 'sessionId', 'evidenceDigest', 'policyVersion', 'reason', 'createdAt', 'updatedAt'].every(key => typeof get(key) === 'string')) return false
  if (!ID.test(String(get('id'))) || !['turn', 'confidence', 'elapsedMs'].every(key => typeof get(key) === 'number' && Number.isFinite(get(key)) && Number(get(key)) >= 0)) return false
  if (!['mode', 'event', 'action', 'status', 'outcome'].every(key => typeof get(key) === 'string')) return false
  if (!['off', 'observe', 'assist'].includes(String(get('mode'))) || !statuses.includes(String(get('status')))) return false
  if (!['planning', 'changed-code', 'repeated-failure', 'completion'].includes(String(get('event')))) return false
  if (!['continue', 'read-evidence', 'revise-plan', 'inspect-failure', 'add-verification', 'review-change'].includes(String(get('action')))) return false
  if (!['unknown', 'action-observed', 'check-passed', 'check-failed'].includes(String(get('outcome')))) return false
  for (const key of ['evidenceRefs', 'gaps']) { const entries = get(key); if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) return false }
  if (get('configurationStatus') !== undefined && !['configured', 'unconfigured', 'unknown'].includes(String(get('configurationStatus')))) return false
  for (const key of ['actionConfidence', 'justifiedProbability']) if (get(key) !== undefined && (typeof get(key) !== 'number' || !Number.isFinite(get(key)) || Number(get(key)) < 0 || Number(get(key)) > 1)) return false
  const card = get('card')
  if (card !== undefined && (typeof card !== 'object' || card === null || !['id', 'stage', 'title'].every(key => typeof Reflect.get(card, key) === 'string') || !Number.isSafeInteger(Reflect.get(card, 'revision')))) return false
  for (const key of ['model', 'outcomeDetail', 'providerIdentity']) if (get(key) !== undefined && typeof get(key) !== 'string') return false
  for (const key of ['inputTokens', 'outputTokens']) if (get(key) !== undefined && (typeof get(key) !== 'number' || !Number.isFinite(get(key)) || Number(get(key)) < 0)) return false
  return Number(get('confidence')) <= 1
}
async function directory(project: string, create: boolean): Promise<string> {
  let path = await realpath(project)
  for (const part of ['.devflow', 'judgements', 'assistance']) {
    path = join(path, part)
    if (create) await mkdir(path, { recursive: false }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('devflow-jev: unsafe assistance directory')
  }
  return path
}
export class AssistanceStore {
  async write(project: string, record: AssistanceRecord): Promise<void> {
    if (!valid(record)) throw new Error('devflow-jev: invalid assistance record')
    const dir = await directory(project, true)
    const temporary = join(dir, `${record.id}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, join(dir, `${record.id}.json`))
  }
  async read(project: string, id: string): Promise<AssistanceRecord> {
    if (!ID.test(id)) throw new Error('devflow-jev: invalid assistance id')
    const path = join(await directory(project, false), `${id}.json`)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('devflow-jev: unsafe assistance record')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!valid(value) || value.id !== id) throw new Error('devflow-jev: malformed assistance record')
    return value
  }
  async list(project: string): Promise<AssistanceRecord[]> {
    let entries: string[]
    try { entries = await readdir(await directory(project, false)) }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records = await Promise.all(entries.filter(file => file.endsWith('.json') && ID.test(file.slice(0, -5))).map(file => this.read(project, file.slice(0, -5))))
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}
