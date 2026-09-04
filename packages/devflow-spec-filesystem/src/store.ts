/**
 * Filesystem Service Provider for the spec seam. Documents live under
 * `<root>/<id>.md` as YAML frontmatter (title, description, `updatedAt`, and
 * the anchors) plus a Markdown body. The root defaults inside `.devflow/`,
 * which `@zhchxiao123/dsh-devflow-fs-guard` denies file tools, so this store is
 * the only write path rather than merely the intended one.
 *
 * Reads always report anchor verdicts beside the content: a reader that cannot
 * learn a document is stale will follow it as if it were true.
 * @module @zhchxiao123/dsh-devflow-spec-filesystem/src/store
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import DevflowSpecStore, { checkAnchorCitations, hasSourceOfTruth, isValidSpecId, worstFreshness } from '@zhchxiao123/dsh-devflow-spec'
import type { AnchorVerdict, SpecAnchor, SpecAnchorRequest, SpecDocument, SpecSummary, SpecWriteRequest, SpecWriteResult, SpecWriteSpec } from '@zhchxiao123/dsh-devflow-spec'
import { evaluateAnchors } from './anchor-eval.ts'
import type { AnchorEvaluationContext, AnchorSourceCache } from './anchor-eval.ts'
import { decodeSpecFile, encodeSpecFile } from './document.ts'
import type { SpecFile } from './document.ts'
import { createLastCommitAt, isGitRepository } from './git.ts'
import { hashSymbol } from './normalize.ts'

/** Provider configuration. */
export interface Config {
  /**
   * Default spec root, used by operations whose caller derives no root of its
   * own; a relative path resolves against the process cwd. It sits inside
   * `.devflow/` so the fs guard's protection covers it without extra config.
   */
  root?: string
  /** Repository root the anchors' relative file paths resolve against. */
  repoRoot?: string
  /**
   * Ceiling on one write's NET growth in bytes: the new file's size minus the
   * sizes of everything it replaces. A merge is usually negative and always
   * passes, which is the point — charging a cluster merge as pure addition
   * would refuse the one move that relieves the pressure.
   *
   * This budgets **reviewability, not context**: architecture document bodies
   * never reach a model in bulk (card results carry the index only), so the
   * cost a large document imposes is on the person who has to read and keep it
   * true. The default assumes a document that says one thing well runs a few
   * kilobytes, so a write adding more than this in net is either several
   * documents fused into one file or a dump — both better caught at write time
   * than discovered at read time. **Revisit the number once a real corpus
   * exists**; it is calibrated on that reasoning, not on measurement.
   */
  maxNetGrowthBytes?: number
}

/** Schemastery validator supplying the provider defaults. */
export const Config: z<Config> = z.object({
  root: z.string().default('.devflow/spec'),
  repoRoot: z.string().default('.'),
  maxNetGrowthBytes: z.number().default(8192),
})

/** Documents are Markdown files; the id is the path below the root without this suffix. */
const EXTENSION = '.md'

/**
 * Collect every document path below one directory.
 * @param root - the spec root.
 * @param prefix - the id prefix accumulated so far.
 * @returns ids of the documents found, unordered.
 */
async function collectIds(root: string, prefix: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ids: string[] = []
  for (const entry of entries) {
    const child = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) ids.push(...await collectIds(root, child))
    else if (entry.name.endsWith(EXTENSION)) ids.push(child.slice(0, -EXTENSION.length))
  }
  return ids
}

/**
 * Filesystem-backed architecture documents registered as `ctx.devflowSpec`.
 */
export class FilesystemDevflowSpecStore extends DevflowSpecStore {
  static Config: z<Config> = Config

  private readonly defaultRoot: string
  private readonly repoRoot: string
  private readonly maxNetGrowthBytes: number
  private lastCommitAt: ((file: string) => Promise<string | undefined>) | undefined
  private probed = false
  /**
   * Parses of the anchored sources, shared by every evaluation this store
   * runs. It is keyed on those files' stats, not on any document, so nothing
   * on the write path invalidates it — listing a scope of forty documents
   * that all anchor the same handful of files parses each file once.
   */
  private readonly sources: AnchorSourceCache = new Map()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.maxNetGrowthBytes = config.maxNetGrowthBytes ?? 8192
    this.defaultRoot = resolve(config.root ?? '.devflow/spec')
    this.repoRoot = resolve(config.repoRoot ?? '.')
  }

  /**
   * The evaluation context for one document, probing git once per store.
   * @param updatedAt - the document's recorded write time.
   * @returns the context; `lastCommitAt` is absent outside a work tree.
   */
  private async buildContext(updatedAt: string): Promise<AnchorEvaluationContext> {
    if (!this.probed) {
      this.probed = true
      if (await isGitRepository(this.repoRoot)) this.lastCommitAt = createLastCommitAt(this.repoRoot)
    }
    return {
      repoRoot: this.repoRoot,
      updatedAt,
      cache: this.sources,
      ...(this.lastCommitAt === undefined ? {} : { lastCommitAt: this.lastCommitAt }),
    }
  }

  /**
   * Read and decode one document file.
   * @param root - the resolved spec root.
   * @param id - the document id.
   * @returns the decoded file and its display path.
   * @throws when the document does not exist or is ill-formed.
   */
  private async load(root: string, id: string): Promise<{ file: SpecFile; path: string }> {
    const path = join(root, `${id}${EXTENSION}`)
    let contents
    try {
      contents = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`spec document ${id} does not exist under ${root}`)
      throw error
    }
    return { file: decodeSpecFile(contents, path), path }
  }

  /**
   * Build one document's summary.
   * @param root - the resolved spec root.
   * @param id - the document id.
   * @returns the summary with rolled-up freshness.
   */
  private async summarize(root: string, id: string): Promise<SpecSummary> {
    const { file, path } = await this.load(root, id)
    const verdicts = await evaluateAnchors(file.anchors, await this.buildContext(file.updatedAt))
    return {
      id,
      title: file.title,
      ...(file.description === undefined ? {} : { description: file.description }),
      path,
      updatedAt: file.updatedAt,
      freshness: worstFreshness(verdicts),
    }
  }

  async list(scope?: string, root?: string): Promise<SpecSummary[]> {
    const resolved = root === undefined ? this.defaultRoot : resolve(root)
    const ids = (await collectIds(resolved, ''))
      .filter(id => scope === undefined || id === scope || id.startsWith(`${scope}/`))
      .sort()
    return Promise.all(ids.map(id => this.summarize(resolved, id)))
  }

  async read(id: string, root?: string): Promise<SpecDocument> {
    const resolved = root === undefined ? this.defaultRoot : resolve(root)
    const { file, path } = await this.load(resolved, id)
    const verdicts = await evaluateAnchors(file.anchors, await this.buildContext(file.updatedAt))
    return {
      id,
      title: file.title,
      ...(file.description === undefined ? {} : { description: file.description }),
      path,
      updatedAt: file.updatedAt,
      freshness: worstFreshness(verdicts),
      anchors: file.anchors,
      body: file.body,
      verdicts,
    }
  }

  async evaluate(id: string, root?: string): Promise<AnchorVerdict[]> {
    const resolved = root === undefined ? this.defaultRoot : resolve(root)
    const { file } = await this.load(resolved, id)
    return evaluateAnchors(file.anchors, await this.buildContext(file.updatedAt))
  }

  resolveWrite(request: SpecWriteRequest): SpecWriteSpec {
    return {
      ...request,
      root: request.root === undefined ? this.defaultRoot : resolve(request.root),
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Fill in the digest of any content-hash anchor stated without one. No
   * caller outside this package can compute it, so requiring one would leave
   * the strongest anchor kind unreachable through the model plane.
   * @param anchors - the request's anchors.
   * @returns anchors with every content-hash digest present; an unresolvable
   *   one stays empty and the evaluation that follows reports it stale.
   */
  private async resolveAnchors(anchors: readonly SpecAnchorRequest[]): Promise<SpecAnchor[]> {
    return Promise.all(anchors.map(async (anchor): Promise<SpecAnchor> => {
      if (anchor.kind !== 'content-hash') return anchor
      if (anchor.hash !== undefined && anchor.hash !== '') return { ...anchor, hash: anchor.hash }
      // An unreadable or missing source leaves the digest empty rather than
      // throwing: the anchor evaluation immediately after says why, in the
      // vocabulary a caller already knows.
      const source = await readFile(join(this.repoRoot, anchor.file), 'utf8').catch(() => undefined)
      return { ...anchor, hash: (source === undefined ? undefined : hashSymbol(source, anchor.symbol)) ?? '' }
    }))
  }

  async write(spec: SpecWriteSpec): Promise<SpecWriteResult> {
    if (!isValidSpecId(spec.id)) {
      return { ok: false, code: 'invalid-id', message: `"${spec.id}" is not a legal spec id; each slash-separated segment must match ^[@a-z0-9][a-z0-9._@-]*$` }
    }
    if (!hasSourceOfTruth(spec.body)) {
      return { ok: false, code: 'missing-source-of-truth', message: `${spec.id} carries no "## Source of truth" section; a document must say what its claims rest on` }
    }
    if (spec.anchors.length === 0) {
      return { ok: false, code: 'no-anchors', message: `${spec.id} declares no anchors; it would report fresh forever and protect nothing` }
    }
    const defect = checkAnchorCitations(spec.anchors, spec.body)
    if (defect !== undefined) return { ok: false, code: defect.code, message: `${spec.id}: ${defect.message}` }

    const replaces = spec.replaces ?? []
    // Sizes come from disk rather than from an index: the budget is about the
    // bytes a reviewer will face, and only the files answer that.
    const replacedSizes = new Map<string, number>()
    for (const id of replaces) {
      const size = await this.byteSize(join(spec.root, `${id}${EXTENSION}`))
      if (size === undefined) {
        return { ok: false, code: 'unknown-replaced', message: `${spec.id} replaces ${id}, which does not exist under ${spec.root}` }
      }
      replacedSizes.set(id, size)
    }

    const path = join(spec.root, `${spec.id}${EXTENSION}`)
    if (!replaces.includes(spec.id) && await this.exists(path)) {
      return { ok: false, code: 'exists', message: `${spec.id} already exists; list it in "replaces" to revise it, or choose another id` }
    }
    const anchors = await this.resolveAnchors(spec.anchors)
    const verdicts = await evaluateAnchors(anchors, await this.buildContext(spec.updatedAt))
    const unresolved = verdicts.filter((verdict): verdict is Extract<AnchorVerdict, { reason: string }> => verdict.status !== 'fresh')
    if (unresolved.length > 0) {
      const detail = unresolved.map(verdict => `${verdict.id} (${verdict.status}: ${verdict.reason})`).join('; ')
      return { ok: false, code: 'anchor-unresolvable', message: `${spec.id} would be born stale — ${detail}` }
    }

    const file: SpecFile = {
      title: spec.title,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      updatedAt: spec.updatedAt,
      anchors,
      body: spec.body,
    }
    const contents = encodeSpecFile(file)
    const removed = [...replacedSizes].reduce((total, [, size]) => total + size, 0)
    const net = Buffer.byteLength(contents) - removed
    if (net > this.maxNetGrowthBytes) {
      return {
        ok: false,
        code: 'budget-exceeded',
        message: `${spec.id} grows the set by ${String(net)} bytes, over the ${String(this.maxNetGrowthBytes)} byte ceiling; merge or retire documents in the same write, or say less`,
      }
    }

    // Nothing above this line has touched the root. The replacement is written
    // before anything is removed, so an interrupted merge leaves duplication
    // rather than a gap.
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
    const superseded = replaces.filter(id => id !== spec.id)
    for (const id of superseded) await rm(join(spec.root, `${id}${EXTENSION}`), { force: true })
    return {
      ok: true,
      document: {
        id: spec.id,
        title: spec.title,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        path,
        updatedAt: spec.updatedAt,
        freshness: 'fresh',
      },
      replaced: superseded,
    }
  }

  /**
   * One document file's size on disk.
   * @param path - the resolved document path.
   * @returns the byte size, or `undefined` when there is no such document.
   */
  private async byteSize(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).size
    } catch {
      // stat is the try's only operation; an unreadable path is reported as
      // absent here and the caller rejects with `unknown-replaced`, naming the
      // id rather than an errno the model can do nothing with.
      return undefined
    }
  }

  /**
   * Whether a document file is already present.
   * @param path - the resolved document path.
   * @returns `true` when the file exists.
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await readFile(path)
      return true
    } catch {
      // Any unreadable path counts as absent here; a genuinely broken root
      // fails at the write that follows, which reports the real errno.
      return false
    }
  }
}

export default FilesystemDevflowSpecStore
