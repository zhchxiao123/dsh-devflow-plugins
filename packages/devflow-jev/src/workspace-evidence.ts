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
  /** Local identities from a prior collection; unchanged pre-existing paths are omitted. */
  baseline?: Readonly<Record<string, string>>
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
  /** Local-only opaque path identities; adapters must omit this metadata from model requests. */
  snapshot?: Readonly<Record<string, string>>
}

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cpp|h|css|scss|html|vue|svelte|md|json|ya?ml|toml|sql|sh)$/iu
const PRIVATE_PATH = /(^|[\/_.-])(credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519|keystore)($|[\/_.-])|\.(pem|key|p12|pfx)$/iu
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]+)/iu,
  new RegExp(String.raw`(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\s*["']?\s*[:=]\s*`
    + String.raw`(?:"(?:\\.|[^"\\\r\n]){8,}"|'(?:\\.|[^'\\\r\n]){8,}'|[^\s"',;}{]{8,})`, 'iu'),
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
    const chunks: Buffer[] = []; let bytes = 0; let exceeded = false; let processError: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) { exceeded = true; child.kill('SIGKILL') }
      else chunks.push(chunk)
    })
    // Wait for close even after abort/error so a rejected collection owns no live Git process.
    child.on('error', (error) => { processError = error })
    child.on('close', (code) => {
      if (signal.aborted) reject(new Error('Git evidence was cancelled.'))
      else if (processError !== undefined) reject(processError)
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

async function file(root: string, path: string, limit: number, signal: AbortSignal): Promise<Buffer | undefined> {
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
    if (!info.isFile()) throw new Error('Non-regular evidence excluded.')
    // Safe large sources still have usable bounded patches; never read their full contents.
    if (info.size > limit) return undefined
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
  for (const value of [options.maxBytes, options.maxFiles, options.maxFileBytes, options.timeoutMs]) {
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
    // Identity metadata is bounded independently of the selected text. This lets
    // later edits displace a large pre-existing dirty set without reading its contents.
    const metadataCoverage = { complete: true }
    const snapshot = async (): Promise<Record<string, string>> => {
      const index = await git(canonical, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', ...STATUS_ARGS.slice(6)], options.maxBytes, active)
      const raw = index.split('\0'); const staged = new Map<string, string>()
      for (let offset = 0; offset + 1 < raw.length; offset += 2) {
        staged.set(relative(canonical, join(gitRoot, raw[offset + 1] as string)), raw[offset] as string)
      }
      const metadata: Record<string, string> = Object.create(null) as Record<string, string>
      let metadataBytes = 2
      for (const entry of changed) {
        active.throwIfAborted()
        metadataBytes += Buffer.byteLength(JSON.stringify(entry.path)) + 68
        if (metadataBytes > options.maxBytes) { metadataCoverage.complete = false; break }
        let identity: string
        try {
          const stat = await lstat(join(canonical, entry.path), { bigint: true })
          identity = JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs], (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value)
        } catch (error: unknown) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' && entry.status.includes('D'))) throw error
          identity = 'deleted'
        }
        metadata[entry.path] = hash(JSON.stringify([entry.status, staged.get(entry.path), identity]))
      }
      return metadata
    }
    const identities = await snapshot()
    if (!metadataCoverage.complete) gap('Workspace identity metadata exceeds evidence budget.', true)
    const relevant = changed.filter(entry => identities[entry.path] === undefined
      || options.baseline?.[entry.path] !== identities[entry.path])
    if (relevant.length < changed.length) gap('Unchanged pre-existing workspace changes were omitted from this task evidence.')
    const selected = relevant.slice(0, options.maxFiles)
    if (selected.length !== relevant.length) gap('Changed file count exceeds evidence budget.', true)
    fingerprint = hash(JSON.stringify(relevant.map(entry => [entry.path, identities[entry.path]])))
    for (const entry of selected) {
      active.throwIfAborted()
      if (!safePath(entry.path)) { gap('A hidden, sensitive, unsupported, or unsafe changed path was excluded.'); continue }
      const status = `${entry.status} ${entry.path}\n`
      if (!take(status)) { gap('Status evidence exceeds byte budget.'); break }
      statuses.push(status)
      if (entry.status === '??') untracked.push(entry.path)
      let content: Buffer | undefined
      try {
        content = await file(result.workspace, entry.path, Math.min(options.maxFileBytes, remaining), active)
        if (content === undefined) gap(`File evidence excluded: ${entry.path}`)
      }
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
        if (sensitive(patch) || binaryOrLink.test(patch) || patch.includes('\uFFFD')) {
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
      let content: Buffer | undefined
      try { content = await file(result.workspace, path, Math.min(options.maxFileBytes, remaining), active) }
      catch { active.throwIfAborted(); continue }
      if (content !== undefined && readable(content) && take(content.toString('utf8'))) {
        files.push({ path, excerpt: content.toString('utf8'), digest: hash(content) })
      }
    }
    gaps.push('Related evidence is limited to conventional sibling source/test files; dependency and test coverage are not established.')
    const final = await git(result.workspace, STATUS_ARGS, options.maxBytes, active)
    if (initial !== final) gap('Workspace status changed while evidence was collected.', true)
    for (const item of files) {
      let current: Buffer | undefined
      try { current = await file(result.workspace, item.path, options.maxFileBytes, active) }
      catch { active.throwIfAborted(); gap('Workspace content changed or became unreadable during collection.', true); continue }
      if (current === undefined || hash(current) !== item.digest) gap('Workspace content changed during collection.', true)
    }
    const finalIdentities = await snapshot()
    const stableMetadata = JSON.stringify(identities) === JSON.stringify(finalIdentities)
    if (!stableMetadata) gap('Workspace metadata or index changed during collection.', true)
    if (metadataCoverage.complete && initial === final && stableMetadata) result.snapshot = identities
  } catch {
    signal?.throwIfAborted()
    gap(active.aborted ? 'Workspace evidence collection timed out.' : 'Workspace Git evidence is unavailable.', true)
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  result.status = statuses.join(''); result.diff = patches.join(''); result.files = files; result.untracked = untracked; result.gaps = gaps
  const { snapshot: _localSnapshot, ...payload } = result
  result.digest = hash(JSON.stringify(payload) + fingerprint + (coverage.incomplete ? randomUUID() : ''))
  return result
}
