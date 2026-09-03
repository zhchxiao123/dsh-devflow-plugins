// The provider's read and write faces against a real tree: reads always carry
// anchor verdicts, and the write path refuses every document that could not be
// checked afterwards — including one that would be born stale.
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SpecStore, { encodeSpecFile, hashSymbol } from '@zhchxiao123/dsh-devflow-spec-filesystem'
import type { SpecAnchor, SpecWriteRequest } from '@zhchxiao123/dsh-devflow-spec'

const SOURCE = 'export function isLegal(from: string): boolean { return from !== "done" }\n'
const BODY = '## Source of truth\n\nThe predicate [[a1]] decides edge legality.\n'

let specRoot: string
let repoRoot: string
let store: InstanceType<typeof SpecStore>

const symbolAnchor: SpecAnchor = { id: 'a1', kind: 'symbol', file: 'src/stages.ts', symbol: 'isLegal' }

function request(overrides: Partial<SpecWriteRequest> = {}): SpecWriteRequest {
  return { id: 'guides/edges', title: 'Edges', body: BODY, anchors: [symbolAnchor], ...overrides }
}

beforeEach(async () => {
  specRoot = await mkdtemp(join(tmpdir(), 'spec-root-'))
  repoRoot = await mkdtemp(join(tmpdir(), 'spec-repo-'))
  await mkdir(join(repoRoot, 'src'), { recursive: true })
  await writeFile(join(repoRoot, 'src/stages.ts'), SOURCE, 'utf8')
  const ctx = new Context()
  await ctx.plugin(SpecStore, { root: specRoot, repoRoot })
  store = ctx.get('devflowSpec') as InstanceType<typeof SpecStore>
})

afterEach(async () => {
  await rm(specRoot, { recursive: true, force: true })
  await rm(repoRoot, { recursive: true, force: true })
})

async function seed(id: string, overrides: Partial<Parameters<typeof encodeSpecFile>[0]> = {}): Promise<void> {
  const path = join(specRoot, `${id}.md`)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, encodeSpecFile({
    title: 'Edges',
    updatedAt: '2026-09-02T00:00:00.000Z',
    anchors: [symbolAnchor],
    body: BODY,
    ...overrides,
  }), 'utf8')
}

describe('write', () => {
  it('commits a document whose anchors all resolve', async () => {
    const result = await store.write(store.resolveWrite(request({ description: 'Edge legality' })))
    expect(result).toMatchObject({ ok: true, document: { id: 'guides/edges', freshness: 'fresh', description: 'Edge legality' } })
    const written = await readFile(join(specRoot, 'guides/edges.md'), 'utf8')
    expect(written).toContain('## Source of truth')
    expect(written).toContain('symbol: isLegal')
  })

  it('leaves no temporary file behind', async () => {
    await store.write(store.resolveWrite(request()))
    await expect(readFile(join(specRoot, 'guides/edges.md.tmp'), 'utf8')).rejects.toThrow()
  })

  it('refuses an id that could open a path of its own', async () => {
    await expect(store.write(store.resolveWrite(request({ id: '../escape' })))).resolves.toMatchObject({ ok: false, code: 'invalid-id' })
  })

  it('refuses a document that never says what it rests on', async () => {
    await expect(store.write(store.resolveWrite(request({ body: 'Some prose citing [[a1]].' })))).resolves.toMatchObject({ ok: false, code: 'missing-source-of-truth' })
  })

  it('refuses a document that anchors nothing', async () => {
    const result = await store.write(store.resolveWrite(request({ anchors: [], body: '## Source of truth\n\nNothing.\n' })))
    expect(result).toMatchObject({ ok: false, code: 'no-anchors' })
  })

  it('refuses a broken citation relation', async () => {
    await expect(store.write(store.resolveWrite(request({ body: '## Source of truth\n\nNo citation here.\n' }))))
      .resolves.toMatchObject({ ok: false, code: 'uncited-anchor' })
  })

  it('refuses a document that would be born stale', async () => {
    const stale: SpecAnchor = { id: 'a1', kind: 'content-hash', file: 'src/stages.ts', symbol: 'isLegal', hash: 'sha1:0' }
    const result = await store.write(store.resolveWrite(request({ anchors: [stale] })))
    expect(result).toMatchObject({ ok: false, code: 'anchor-unresolvable' })
    expect(result).toHaveProperty('message', expect.stringContaining('born stale'))
  })

  it('refuses to overwrite an existing document', async () => {
    await store.write(store.resolveWrite(request()))
    await expect(store.write(store.resolveWrite(request()))).resolves.toMatchObject({ ok: false, code: 'exists' })
  })

  it('lets the caller pin a root, and stamps the write time', () => {
    const spec = store.resolveWrite(request({ root: specRoot }))
    expect(spec.root).toBe(specRoot)
    expect(Number.isNaN(Date.parse(spec.updatedAt))).toBe(false)
  })
})

describe('read', () => {
  it('carries the verdicts beside the body', async () => {
    await seed('guides/edges')
    const document = await store.read('guides/edges')
    expect(document).toMatchObject({ id: 'guides/edges', freshness: 'fresh', body: BODY })
    expect(document.verdicts).toEqual([{ id: 'a1', status: 'fresh' }])
  })

  it('reports stale once the anchored symbol is renamed', async () => {
    await seed('guides/edges')
    await writeFile(join(repoRoot, 'src/stages.ts'), SOURCE.replace('isLegal', 'isPermitted'), 'utf8')
    const document = await store.read('guides/edges')
    expect(document.freshness).toBe('stale')
    expect(document.verdicts[0]).toMatchObject({ status: 'stale' })
  })

  it('keeps an optional description and omits it when absent', async () => {
    await seed('with-description', { description: 'Present' })
    await seed('without-description')
    expect(await store.read('with-description')).toHaveProperty('description', 'Present')
    expect(await store.read('without-description')).not.toHaveProperty('description')
  })

  it('names the document it cannot find', async () => {
    await expect(store.read('guides/absent')).rejects.toThrow(/guides\/absent does not exist/)
  })

  it('accepts a caller-pinned root', async () => {
    await seed('guides/edges')
    await expect(store.read('guides/edges', specRoot)).resolves.toMatchObject({ id: 'guides/edges' })
  })
})

describe('evaluate', () => {
  it('reports one verdict per anchor without the body', async () => {
    await seed('guides/edges')
    await expect(store.evaluate('guides/edges')).resolves.toEqual([{ id: 'a1', status: 'fresh' }])
    await expect(store.evaluate('guides/edges', specRoot)).resolves.toHaveLength(1)
  })
})

describe('list', () => {
  it('walks nested scopes and orders by id', async () => {
    await seed('guides/edges')
    await seed('@scope/pkg/backend/errors')
    await writeFile(join(specRoot, 'guides/notes.txt'), 'ignored', 'utf8')
    const ids = (await store.list()).map(summary => summary.id)
    expect(ids).toEqual(['@scope/pkg/backend/errors', 'guides/edges'])
  })

  it('narrows to one scope, by exact id and by prefix', async () => {
    await seed('guides/edges')
    await seed('guides')
    await seed('other/doc')
    expect((await store.list('guides')).map(summary => summary.id)).toEqual(['guides', 'guides/edges'])
    expect(await store.list('missing')).toEqual([])
  })

  it('carries description and freshness in the index', async () => {
    await seed('guides/edges', { description: 'Edge legality' })
    const [summary] = await store.list()
    expect(summary).toMatchObject({ description: 'Edge legality', freshness: 'fresh' })
  })

  it('reports an empty root rather than failing', async () => {
    await expect(store.list(undefined, join(specRoot, 'nowhere'))).resolves.toEqual([])
  })

  it('rejects when the root is not a directory at all', async () => {
    const file = join(specRoot, 'a-file')
    await writeFile(file, 'x', 'utf8')
    await expect(store.list(undefined, file)).rejects.toThrow()
  })
})

describe('reads that cannot proceed', () => {
  it('rejects rather than reporting absent when the path exists but is unreadable', async () => {
    await mkdir(join(specRoot, 'a-directory.md'), { recursive: true })
    await expect(store.read('a-directory')).rejects.toThrow()
  })
})

describe('churn anchors with git', () => {
  it('go stale once the anchored file is committed after the document', async () => {
    const run = promisify(execFile)
    await run('git', ['init', '-q'], { cwd: repoRoot })
    await run('git', ['add', 'src/stages.ts'], { cwd: repoRoot })
    await run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'add'], { cwd: repoRoot })
    const ctx = new Context()
    await ctx.plugin(SpecStore, { root: specRoot, repoRoot })
    const gitStore = ctx.get('devflowSpec') as InstanceType<typeof SpecStore>
    await seed('guides/churn', { anchors: [{ id: 'a1', kind: 'churn', file: 'src/stages.ts' }] })
    const verdicts = await gitStore.evaluate('guides/churn')
    expect(verdicts[0]).toMatchObject({ status: 'stale' })
  })
})

describe('churn anchors without git', () => {
  it('are unevaluable, so the document is not reported fresh', async () => {
    await seed('guides/churn', { anchors: [{ id: 'a1', kind: 'churn', file: 'src/stages.ts' }] })
    const document = await store.read('guides/churn')
    expect(document.verdicts[0]).toMatchObject({ status: 'unevaluable' })
    expect(document.freshness).toBe('unevaluable')
  })
})

describe('content-hash anchors', () => {
  it('take the current digest when the caller states none', async () => {
    const result = await store.write(store.resolveWrite(request({
      anchors: [{ id: 'a1', kind: 'content-hash', file: 'src/stages.ts', symbol: 'isLegal' }],
    })))
    expect(result).toMatchObject({ ok: true })
    const written = await readFile(join(specRoot, 'guides/edges.md'), 'utf8')
    expect(written).toMatch(/hash: sha1:[0-9a-f]{40}/)
    await expect(store.evaluate('guides/edges')).resolves.toEqual([{ id: 'a1', status: 'fresh' }])
  })

  it('cannot be filled for a symbol that is not there, and the write says so', async () => {
    const result = await store.write(store.resolveWrite(request({
      anchors: [{ id: 'a1', kind: 'content-hash', file: 'src/stages.ts', symbol: 'vanished' }],
    })))
    expect(result).toMatchObject({ ok: false, code: 'anchor-unresolvable' })
  })

  it('cannot be filled from a file that is not there either', async () => {
    const result = await store.write(store.resolveWrite(request({
      anchors: [{ id: 'a1', kind: 'content-hash', file: 'src/missing.ts', symbol: 'isLegal' }],
    })))
    expect(result).toMatchObject({ ok: false, code: 'anchor-unresolvable' })
  })

  it('stay fresh while the recorded hash matches', async () => {
    const hash = hashSymbol(SOURCE, 'isLegal') as string
    await seed('guides/hash', { anchors: [{ id: 'a1', kind: 'content-hash', file: 'src/stages.ts', symbol: 'isLegal', hash }] })
    await expect(store.evaluate('guides/hash')).resolves.toEqual([{ id: 'a1', status: 'fresh' }])
  })
})

describe('defaults', () => {
  it('resolves a root under .devflow when the deployment states none', async () => {
    const ctx = new Context()
    await ctx.plugin(SpecStore, {})
    const defaulted = ctx.get('devflowSpec') as InstanceType<typeof SpecStore>
    expect(defaulted.resolveWrite(request()).root.endsWith(join('.devflow', 'spec'))).toBe(true)
  })

  it('applies the same fallbacks when constructed without the config schema', () => {
    // Direct construction skips schemastery, which is how the class's own
    // `??` fallbacks — not the schema's defaults — get exercised.
    const bare = new SpecStore(new Context(), {})
    expect(bare.resolveWrite(request()).root.endsWith(join('.devflow', 'spec'))).toBe(true)
  })
})
