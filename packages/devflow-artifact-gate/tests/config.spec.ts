// Load-time configuration failures name the offending config item, and the
// kind-spec service publishes exactly the configured specs — normalized,
// deep frozen, and gone when the fiber disposes.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as DevflowArtifactGate from '@zhchxiao123/dsh-devflow-artifact-gate'
import type { ArtifactSpecs, Config } from '@zhchxiao123/dsh-devflow-artifact-gate'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function withStore(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devflow-artifact-config-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  return ctx
}

describe('devflow-artifact-gate configuration', () => {
  it.each([
    {
      label: 'a malformed edge key',
      config: { specs: { prd: {} }, edges: { 'draft=>designing': ['prd'] } },
      message: 'edges names invalid edge "draft=>designing"',
    },
    {
      label: 'an unknown location name',
      config: { specs: { prd: {} }, edges: { 'draft->shipping': ['prd'] } },
      message: 'edges names invalid edge "draft->shipping"',
    },
    {
      label: 'an edge requiring an undeclared kind',
      config: { edges: { 'draft->designing': ['prd'] } },
      message: 'edges["draft->designing"] requires kind "prd", which specs does not declare',
    },
    {
      label: 'an ill-formed kind key',
      config: { specs: { 'Bad Kind': {} } },
      message: 'specs names invalid kind "Bad Kind"',
    },
    {
      label: 'a blank frontmatter field',
      config: { specs: { design: { frontmatter: [' '] } } },
      message: 'specs["design"].frontmatter[0] must be a non-empty string',
    },
    {
      label: 'a blank section title',
      config: { specs: { design: { sections: ['Approach', ''] } } },
      message: 'specs["design"].sections[1] must be a non-empty string',
    },
  ])('fails the load on $label', async ({ config, message }) => {
    const ctx = await withStore()
    await expect(ctx.plugin(DevflowArtifactGate, config as Config)).rejects.toThrow(message)
  })

  it('applies its defaults under direct application outside Loader normalization', async () => {
    const ctx = await withStore()
    // No config at all: nothing is gated and nothing is published beyond the
    // empty spec set.
    const bare = await ctx.plugin((child: Context) => {
      DevflowArtifactGate.apply(child, {})
    })
    expect(ctx.get('devflowArtifactSpecs')).toEqual({})
    await bare.dispose()
    // A kind declared with neither list settles both to omitted.
    await ctx.plugin((child: Context) => {
      DevflowArtifactGate.apply(child, { specs: { prd: {} } })
    })
    expect(ctx.get('devflowArtifactSpecs')).toEqual({ prd: {} })
  })

  it('publishes the configured specs as a deep-frozen devflowArtifactSpecs service', async () => {
    const ctx = await withStore()
    await ctx.plugin(DevflowArtifactGate, {
      specs: {
        prd: { frontmatter: ['card', 'title'], sections: [] },
        'review-verdict': { sections: ['Verdict'] },
      },
      // A kind no edge references stays published: it can exist purely as the
      // template a producer reads.
      edges: {},
    }).await()
    const specs = ctx.get('devflowArtifactSpecs') as ArtifactSpecs
    // The empty sections list normalized away: empty equals omitted.
    expect(specs).toEqual({
      prd: { frontmatter: ['card', 'title'] },
      'review-verdict': { sections: ['Verdict'] },
    })
    expect(Object.isFrozen(specs)).toBe(true)
    expect(Object.isFrozen(specs.prd)).toBe(true)
    expect(Object.isFrozen(specs.prd.frontmatter)).toBe(true)
    expect(Object.isFrozen(specs['review-verdict'].sections)).toBe(true)
  })
})
