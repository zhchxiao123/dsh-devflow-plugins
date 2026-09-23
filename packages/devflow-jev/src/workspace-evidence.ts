import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'

export interface WorkspaceEvidenceOptions {
  maxBytes: number
  maxFiles: number
  maxFileBytes: number
  timeoutMs: number
}
export interface WorkspaceEvidence {
  workspace: string
  head: string
  status: string
  diff: string
  files: readonly { path: string; excerpt: string; digest: string }[]
  untracked: readonly string[]
  gaps: readonly string[]
  digest: string
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cpp|h|css|scss|html|vue|svelte|md|json|ya?ml|toml|sql|sh)$/iu
const PRIVATE_PATH = /(^|[\/_.-])(credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519|keystore)($|[\/_.-])|\.(pem|key|p12|pfx)$/iu
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]+)/iu,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\s*["']?\s*[:=]\s*["']?[^\s"',;}{]{8,}/iu,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/iu,
]
const sensitive = (text: string): boolean => SECRETS.some(pattern => pattern.test(text))
const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none',
  '--', '.', ':(exclude).devflow', ':(exclude).jev', ':(exclude).git']
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function safePath(path: string): boolean {
  return !isAbsolute(path) && !path.includes('\\') && !/[\x00-\x1f\x7f]/u.test(path)
    && path.split('/').every(part => part !== '' && !part.startsWith('.'))
    && !PRIVATE_PATH.test(path) && !sensitive(path) && SOURCE.test(path)
}

/** Git never inherits repository selectors, external diff commands, or optional index writes. */
async function git(cwd: string, args: readonly string[], limit: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'], signal,
    })
    const chunks: Buffer[] = []; let bytes = 0; let exceeded = false
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) { exceeded = true; child.kill('SIGKILL') }
      else chunks.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (signal.aborted) reject(new Error('Git evidence was cancelled.'))
      else if (exceeded) reject(new Error('Git output exceeds evidence budget.'))
      else if (code !== 0) reject(new Error('Git evidence is unavailable.'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

interface Entry { path: string; status: string }
function entries(text: string): Entry[] {
  const result: Entry[] = []; const parts = text.split('\0')
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (!part) continue
    result.push({ path: part.slice(3), status: part.slice(0, 2) })
  }
  return result
}

async function file(root: string, path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  let current = root
  for (const part of path.split('/')) {
    signal.throwIfAborted(); current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink evidence excluded.')
  }
  const actual = await realpath(current); const local = relative(root, actual)
  if (isAbsolute(local) || local.startsWith('..')) throw new Error('Outside-workspace evidence excluded.')
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Non-regular or oversized evidence excluded.')
    const buffer = Buffer.alloc(limit + 1)
    signal.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    if (bytesRead !== info.size) throw new Error('File changed or could not be completely read.')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

function readable(buffer: Buffer): boolean {
  const text = buffer.toString('utf8')
  return !buffer.includes(0) && !text.includes('\uFFFD') && !sensitive(text)
}
function related(path: string): string[] {
  const ext = extname(path); const name = basename(path, ext)
  if (/(?:\.test|\.spec|_test)$/u.test(name)) return [join(dirname(path), name.replace(/(?:\.test|\.spec|_test)$/u, '') + ext)]
  return [join(dirname(path), `${name}.spec${ext}`), join(dirname(path), `${name}.test${ext}`), join(dirname(dirname(path)), 'tests', `${name}.spec${ext}`)]
}

/**
 * Changed content is collected only from safe regular files and path-scoped Git patches.
 * Omitted content retains a local metadata/index fingerprint, never source text.
 * Unenumerated or unstable observations have a non-reusable digest.
 * maxBytes bounds text evidence; maxFiles bounds changed/related file inspections.
 */
export async function collectWorkspaceEvidence(
  cwd: string, options: WorkspaceEvidenceOptions, signal?: AbortSignal,
): Promise<WorkspaceEvidence> {
  for (const value of Object.values(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Evidence budgets must be positive safe integers.')
  }
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = (): void => { controller.abort(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error('Workspace evidence timed out.')) }, options.timeoutMs)
  const active = controller.signal
  const result: WorkspaceEvidence = { workspace: cwd, head: '', status: '', diff: '', files: [], untracked: [], gaps: [], digest: '' }
  const gaps: string[] = []; const files: { path: string; excerpt: string; digest: string }[] = []
  const untracked: string[] = []; const statuses: string[] = []; const patches: string[] = []
  let remaining = options.maxBytes; const coverage = { incomplete: false }
  let fingerprint = ''
  const gap = (message: string, unstable = false): void => {
    if (unstable) coverage.incomplete = true
    if (gaps.length < options.maxFiles + 4) gaps.push(message)
  }
  const take = (text: string): boolean => {
    const bytes = Buffer.byteLength(text)
    if (bytes > remaining) return false
    remaining -= bytes; return true
  }
  try {
    const canonical = await realpath(cwd)
    result.workspace = canonical
    const root = (await git(canonical, ['rev-parse', '--show-toplevel'], options.maxBytes, active)).trim()
    const gitRoot = await realpath(root)
    try { result.head = (await git(result.workspace, ['rev-parse', '--verify', 'HEAD'], 128, active)).trim() }
    catch { active.throwIfAborted(); gaps.push('Repository has no readable HEAD; staged changes are compared with the empty tree.') }
    const initial = await git(result.workspace, STATUS_ARGS, options.maxBytes, active)
    const changed = entries(initial).map(entry => ({ ...entry, path: relative(canonical, join(gitRoot, entry.path)) }))
    if (changed.some(entry => isAbsolute(entry.path) || entry.path.split('/').includes('..'))) throw new Error('Outside-workspace Git path.')
    const selected = changed.slice(0, options.maxFiles)
    if (selected.length !== changed.length) gap('Changed file count exceeds evidence budget.', true)
    // Only this hash leaves the collector; hidden paths and staged object names stay local.
    const snapshot = async (): Promise<string> => {
      const index = await git(canonical, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', ...STATUS_ARGS.slice(6)], options.maxBytes, active)
      const metadata: string[] = []
      for (const entry of selected) {
        active.throwIfAborted()
        try {
          const stat = await lstat(join(canonical, entry.path), { bigint: true })
          metadata.push(JSON.stringify([entry.path, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs], (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value))
        } catch (error: unknown) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' && entry.status.includes('D'))) throw error
          metadata.push(JSON.stringify([entry.path, 'deleted']))
        }
      }
      return hash(JSON.stringify([initial, index, metadata]))
    }
    fingerprint = await snapshot()
    for (const entry of selected) {
      active.throwIfAborted()
      if (!safePath(entry.path)) { gap('A hidden, sensitive, unsupported, or unsafe changed path was excluded.'); continue }
      const status = `${entry.status} ${entry.path}\n`
      if (!take(status)) { gap('Status evidence exceeds byte budget.'); break }
      statuses.push(status)
      if (entry.status === '??') untracked.push(entry.path)
      let content: Buffer | undefined
      try { content = await file(result.workspace, entry.path, Math.min(options.maxFileBytes, remaining), active) }
      catch (error: unknown) {
        active.throwIfAborted()
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' && entry.status.includes('D'))) {
          gap(`File evidence excluded: ${entry.path}`); continue
        }
      }
      if (content !== undefined && !readable(content)) { gap(`Binary or sensitive content excluded: ${entry.path}`); continue }
      if (content !== undefined) {
        take(content.toString('utf8')); files.push({ path: entry.path, excerpt: content.toString('utf8'), digest: hash(content) })
      }
      if (entry.status === '??') continue
      for (const staged of [true, false]) {
        const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--unified=3']
        if (staged) args.push('--cached')
        args.push('--', entry.path)
        let patch: string
        try { patch = await git(result.workspace, args, Math.min(options.maxFileBytes, remaining), active) }
        catch { active.throwIfAborted(); gap(`Diff unavailable or over budget: ${entry.path}`); continue }
        const binaryOrLink = /^(?:Binary files|GIT binary patch)|^(?:new|old|deleted file|new file) mode 120000|^index .* 120000/mu
        if (sensitive(patch) || binaryOrLink.test(patch)) {
          gap(`Sensitive, binary, or symlink diff excluded: ${entry.path}`); continue
        }
        const labeled = patch === '' ? '' : `${staged ? 'STAGED' : 'UNSTAGED'}\n${patch}`
        if (take(labeled)) patches.push(labeled)
        else gap(`Diff evidence exceeds byte budget: ${entry.path}`)
      }
    }
    const candidates = [...new Set(files.flatMap(item => related(item.path)))]
      .filter(path => safePath(path) && !changed.some(entry => entry.path === path))
    for (const path of candidates.slice(0, Math.max(0, options.maxFiles - selected.length))) {
      let content: Buffer
      try { content = await file(result.workspace, path, Math.min(options.maxFileBytes, remaining), active) }
      catch { active.throwIfAborted(); continue }
      if (readable(content) && take(content.toString('utf8'))) files.push({ path, excerpt: content.toString('utf8'), digest: hash(content) })
    }
    gaps.push('Related evidence is limited to conventional sibling source/test files; dependency and test coverage are not established.')
    const final = await git(result.workspace, STATUS_ARGS, options.maxBytes, active)
    if (initial !== final) gap('Workspace status changed while evidence was collected.', true)
    for (const item of files) {
      let current: Buffer
      try { current = await file(result.workspace, item.path, options.maxFileBytes, active) }
      catch { active.throwIfAborted(); gap('Workspace content changed or became unreadable during collection.', true); continue }
      if (hash(current) !== item.digest) gap('Workspace content changed during collection.', true)
    }
    if (fingerprint !== await snapshot()) gap('Workspace metadata or index changed during collection.', true)
  } catch {
    signal?.throwIfAborted()
    gap(active.aborted ? 'Workspace evidence collection timed out.' : 'Workspace Git evidence is unavailable.', true)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  result.status = statuses.join(''); result.diff = patches.join(''); result.files = files; result.untracked = untracked; result.gaps = gaps
  result.digest = hash(JSON.stringify(result) + fingerprint + (coverage.incomplete ? randomUUID() : ''))
  return result
}
