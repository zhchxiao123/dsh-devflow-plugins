/** Portable project choices; runtime credentials and deployment receipts stay private. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ProjectSettings {
  app?: string
  targetUrl?: string
  model?: { provider: string; model: string; family?: string }
  limits?: { timeoutMs?: number; cleanupTimeoutMs?: number; maxSteps?: number }
  suites?: Record<string, { suite: string; suiteSha256: string; buildId: string }>
}
const SETTINGS = '.devflow/midscene/settings.json'
/** A fixed input ceiling prevents repository files from exhausting the host. */
const MAX_BYTES = 262_144
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected Midscene settings object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown Midscene setting; secrets and runtime paths are not project settings')
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error('Expected bounded single-line setting')
  return value
}
export function projectRelativePath(value: unknown): string {
  const path = text(value)
  if (path !== '.' && (!/^[\w.@ -]+(?:\/[\w.@ -]+)*$/.test(path) || path.split('/').some(part => part === '..' || part === '.')))
    throw new Error('Expected portable project-relative path')
  return path
}
export function projectTargetUrl(value: unknown): string {
  const url = new URL(text(value))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Expected HTTP target without credentials, query or fragment')
  return url.href
}
export function parseProjectSettings(value: unknown): ProjectSettings {
  const source = object(value)
  keys(source, ['app', 'targetUrl', 'model', 'limits', 'suites'])
  const result: ProjectSettings = {}
  if (source.app !== undefined) result.app = projectRelativePath(source.app)
  if (source.targetUrl !== undefined) result.targetUrl = projectTargetUrl(source.targetUrl)
  if (source.model !== undefined) {
    const model = object(source.model)
    keys(model, ['provider', 'model', 'family'])
    result.model = { provider: text(model.provider), model: text(model.model) }
    if (model.family !== undefined) result.model.family = text(model.family)
  }
  if (source.limits !== undefined) {
    const limits = object(source.limits)
    keys(limits, ['timeoutMs', 'cleanupTimeoutMs', 'maxSteps'])
    result.limits = {}
    for (const key of ['timeoutMs', 'cleanupTimeoutMs', 'maxSteps'] as const) {
      const value = limits[key]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('Midscene limits require positive safe integers')
      result.limits[key] = value
    }
  }
  if (source.suites !== undefined) {
    const suites = object(source.suites)
    result.suites = {}
    for (const [card, value] of Object.entries(suites)) {
      if (!/^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card)) throw new Error('Expected Devflow card id')
      const binding = object(value)
      keys(binding, ['suite', 'suiteSha256', 'buildId'])
      const suiteSha256 = text(binding.suiteSha256)
      if (!/^[a-f0-9]{64}$/.test(suiteSha256)) throw new Error('Expected approved suite SHA256')
      result.suites[card] = { suite: projectRelativePath(binding.suite), suiteSha256, buildId: text(binding.buildId) }
    }
  }
  return result
}
/** Reject links in every existing path component, including links within the project. */
async function checkedPath(workspace: string, relative: string): Promise<string> {
  const root = await realpath(workspace)
  const parts = projectRelativePath(relative).split('/')
  let path = root
  for (const part of parts) {
    path = join(path, part)
    const stat = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('Midscene project paths must not traverse symbolic links')
  }
  return path
}
async function verifyOpenedPath(workspace: string, relative: string, file: FileHandle): Promise<void> {
  const path = await checkedPath(workspace, relative)
  const [canonical, current, opened] = await Promise.all([realpath(path), lstat(path), file.stat()])
  if (canonical !== path || current.dev !== opened.dev || current.ino !== opened.ino)
    throw new Error('Midscene project input changed while opening')
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
/** Read a regular bounded repository file without following its final symlink. */
export async function readProjectFile(workspace: string, relative: string): Promise<string | undefined> {
  const path = await checkedPath(workspace, relative)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (isMissing(error)) return undefined
    throw error
  })
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Midscene project input must be a bounded regular file')
    await verifyOpenedPath(workspace, relative, file)
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_BYTES) throw new Error('Midscene project input exceeds size limit')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}
export async function readSettings(workspace: string): Promise<ProjectSettings> {
  const source = await readProjectFile(workspace, SETTINGS)
  return source === undefined ? {} : parseProjectSettings(JSON.parse(source))
}
/** Whole-document replacement is atomic; callers must not use read/merge for concurrent updates. */
export async function writeSettings(workspace: string, settings: ProjectSettings): Promise<void> {
  const data = `${JSON.stringify(parseProjectSettings(settings), null, 2)}\n`
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Midscene project settings exceed size limit')
  await writeProjectFile(workspace, SETTINGS, data)
}
/** Atomic bounded repository write for plugin-owned settings, suites and gate requirements. */
export async function writeProjectFile(workspace: string, relative: string, data: string): Promise<void> {
  projectRelativePath(relative)
  if (!relative.startsWith('.devflow/')) throw new Error('Midscene writes must stay under .devflow')
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Midscene project input exceeds size limit')
  const root = await realpath(workspace)
  const parents = relative.split('/').slice(0, -1)
  for (let count = 1; count <= parents.length; count++) {
    const relative = parents.slice(0, count).join('/')
    const path = await checkedPath(root, relative)
    await mkdir(path, { recursive: true })
  }
  const path = await checkedPath(root, relative)
  const temporary = join(dirname(path), `.settings-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await verifyOpenedPath(root, `${parents.join('/')}/${basename(temporary)}`, file)
      await file.writeFile(data); await file.sync()
    } finally { await file.close() }
    await checkedPath(root, relative)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

/** Cross-process exclusion for settings read/merge operations. A crashed owner leaves a visible lock for explicit recovery. */
export async function withProjectMutation<T>(workspace: string, run: () => Promise<T>): Promise<T> {
  const root = await realpath(workspace)
  for (const relative of ['.devflow', '.devflow/midscene']) await mkdir(await checkedPath(root, relative), { recursive: true })
  const lock = await checkedPath(root, '.devflow/midscene/operation.lock')
  const file = await open(lock, 'wx', 0o600).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`MIDSCENE_PROJECT_BUSY: inspect ${lock}; remove only after its owner has exited`)
    throw error
  })
  try {
    await verifyOpenedPath(root, '.devflow/midscene/operation.lock', file)
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return await run()
  } finally { await file.close(); await rm(lock) }
}
