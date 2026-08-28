// Artifact feeding around the dispatch: configured stage `inputs` inline each
// kind's newest registration into the child prompt (best-effort — unregistered
// kinds skip silently, unreadable files warn and skip, the dispatch always
// happens), and `produces` renders the kind's structure template from the
// optional devflowArtifactSpecs service beside the registration instruction.

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call,
 * typescript/no-unsafe-member-access, typescript/no-unsafe-argument --
 * `Promise.withResolvers` resolves to an error type here: the linter builds no
// program for files outside the packages' `include: ["src"]`, so it has neither
// the ES2024 lib nor our tsconfig. `pnpm run typecheck` does type these files.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { DevActor } from '@zhchxiao123/dsh-devflow'
import FilesystemDevflowStore from '@zhchxiao123/dsh-devflow-filesystem'
import * as DevflowArtifactGate from '@zhchxiao123/dsh-devflow-artifact-gate'
import * as DevflowDriver from '@zhchxiao123/dsh-devflow-driver'
import { injectFsAccessDenied, resetFsFaults, runWithFsFault } from '../../../tests/fs-fault'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      runWithFsFault('readFile', args[0], () => actual.readFile(...args)),
  }
})

const AGENT: DevActor = { kind: 'agent', session: 'stub-child-1' }

interface StartedChild {
  prompt: string
  settle: (result: SubagentResult) => void
}

const MODEL_ROUTE = { provider: 'test-provider', model: 'test-model' }

/** Controllable provider: each start records its prompt and awaits manual settlement. */
function stubProvider(name: string, started: StartedChild[]): SubagentProvider {
  let seq = 0
  return {
    name,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start(request: SubagentStartRequest) {
      const settled = Promise.withResolvers<SubagentResult>()
      started.push({
        prompt: request.prompt.map(block => block.type === 'text' ? block.text : '').join(''),
        settle: settled.resolve,
      })
      const run: SubagentRun = {
        id: SessionId(`stub-child-${++seq}`),
        localAgent: undefined,
        result: settled.promise,
        dispose: () => Promise.resolve(),
      }
      return Promise.resolve(run)
    },
  }
}

const COMPLETED: SubagentResult = { output: [], stopReason: 'completed' }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  resetFsFaults()
})

async function writeCard(id: string, journalLines: string[]): Promise<void> {
  const dir = join(root!, 'tasks', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'card.md'), `---\ntitle: Card ${id}\n---\n\nObjective body of ${id}.\n`)
  await writeFile(join(dir, 'journal.jsonl'), journalLines.join('\n') + '\n')
}

async function writeArtifact(id: string, name: string, content: string): Promise<void> {
  const dir = join(root!, 'tasks', id, 'artifacts')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), content)
}

const AT_READY = [
  '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
  '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
  '{"rev":3,"at":"t3","type":"transition","from":"designing","to":"ready"}',
]

interface Booted {
  store: FilesystemDevflowStore
  started: StartedChild[]
  ctx: Context
}

async function boot(
  stages: DevflowDriver.Config['stages'],
  specs?: DevflowArtifactGate.Config['specs'],
): Promise<Booted> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
  const ctx = new Context()
  context = ctx
  const started: StartedChild[] = []
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(stubProvider('stub', started))
  await ctx.plugin(FilesystemDevflowStore, { root }).await()
  if (specs !== undefined) await ctx.plugin(DevflowArtifactGate, { specs }).await()
  await ctx.plugin(DevflowDriver, { stages, maxConcurrentCards: 1 }).await()
  return { store: ctx.get('devflow') as FilesystemDevflowStore, started, ctx }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('devflow-driver artifact feeding', () => {
  it('inlines each input kind\'s newest registration between the card body and the closing contract', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0001-fed', [
      '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
      '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
      '{"rev":3,"at":"t3","type":"artifact","path":"artifacts/3-design.md","stage":"designing","kind":"design"}',
      '{"rev":4,"at":"t4","type":"artifact","path":"artifacts/4-design.md","stage":"designing","kind":"design"}',
      '{"rev":5,"at":"t5","type":"transition","from":"designing","to":"ready"}',
    ])
    await writeArtifact('0001-fed', '3-design.md', 'Superseded design round.\n')
    await writeArtifact('0001-fed', '4-design.md', 'Current design: feed this one.\n')
    const { started, ctx } = await boot({
      ready: { provider: 'stub', instructions: 'Take the card into development.', inputs: ['design', 'review'] },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await until(() => started.length === 1, 'the fed dispatch')

    // The whole prompt: only the newest design registration is fed (rev 3 is
    // history, not context), the unregistered review kind skips silently (the
    // first round has no review yet), and the fed artifact sits between the
    // card body and the fixed closing contract.
    expect(started[0].prompt).toBe(`Take the card into development.

You are driving devflow task card 0001-fed at stage "ready" (revision 5).

# Card 0001-fed

Objective body of 0001-fed.

--- artifact design (rev 4) ---
Current design: feed this one.


Work the card at this stage. When the stage's work is complete, move the card onward with
the devflow_transition tool (register deliverables first with devflow_attach_artifact);
if you cannot proceed, move it to "blocked" with a reason instead of guessing.`)
    expect(warn).not.toHaveBeenCalled()
    started[0].settle(COMPLETED)
  })

  it('keeps the prompt of a stage with neither inputs nor produces exactly as before', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0009-legacy', AT_READY)
    const { started } = await boot({
      ready: { provider: 'stub', instructions: 'Take the card into development.' },
    })
    await until(() => started.length === 1, 'the legacy dispatch')

    // The pre-feeding prompt, byte for byte: the new sections are empty
    // splices, so an unconfigured stage dispatches the exact prior text.
    expect(started[0].prompt).toBe(`Take the card into development.

You are driving devflow task card 0009-legacy at stage "ready" (revision 3).

# Card 0009-legacy

Objective body of 0009-legacy.

Work the card at this stage. When the stage's work is complete, move the card onward with
the devflow_transition tool (register deliverables first with devflow_attach_artifact);
if you cannot proceed, move it to "blocked" with a reason instead of guessing.`)
    started[0].settle(COMPLETED)
  })

  it('feeds the rework round the newest revision, not the one the first round saw', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0002-rework', [
      '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
      '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
      '{"rev":3,"at":"t3","type":"artifact","path":"artifacts/3-review.md","stage":"designing","kind":"review"}',
      '{"rev":4,"at":"t4","type":"transition","from":"designing","to":"ready"}',
      '{"rev":5,"at":"t5","type":"transition","from":"ready","to":"developing"}',
    ])
    await writeArtifact('0002-rework', '3-review.md', 'First review round.\n')
    const { store, started } = await boot({
      developing: { provider: 'stub', inputs: ['review'] },
    })
    await until(() => started.length === 1, 'the first-round dispatch')
    expect(started[0].prompt).toContain('--- artifact review (rev 3) ---')
    expect(started[0].prompt).toContain('First review round.')

    // The next review lands while the child is engaged; settling the child
    // re-reads the card and re-enters it at its advanced revision.
    const attached = await store.attachArtifact({
      id: DevflowCardId('0002-rework'), kind: 'review', content: 'Second review round: fix the seam.\n', expectedRevision: 5, by: AGENT,
    })
    expect(attached.ok).toBe(true)
    started[0].settle(COMPLETED)

    await until(() => started.length === 2, 'the rework dispatch')
    expect(started[1].prompt).toContain('--- artifact review (rev 6) ---')
    expect(started[1].prompt).toContain('Second review round: fix the seam.')
    expect(started[1].prompt).not.toContain('First review round.')
    started[1].settle(COMPLETED)
  })

  it('renders the produced kind\'s template from devflowArtifactSpecs beside the registration instruction', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0003-template', AT_READY)
    const { started } = await boot(
      { ready: { provider: 'stub', produces: 'design' } },
      { design: { frontmatter: ['card', 'kind'], sections: ['Approach', 'Compatibility'] } },
    )
    await until(() => started.length === 1, 'the templated dispatch')

    // The whole prompt: the frontmatter fence, the section skeleton, and the
    // kind + content registration instruction, between the body and the
    // closing contract.
    expect(started[0].prompt).toBe(`You are driving devflow task card 0003-template at stage "ready" (revision 3).

# Card 0003-template

Objective body of 0003-template.

This stage's deliverable is a "design" artifact, shaped like:

---
card: <value>
kind: <value>
---

## Approach

…

## Compatibility

…

Register its complete Markdown with devflow_attach_artifact's kind + content form (kind "design");
the store writes and records the file itself.

Work the card at this stage. When the stage's work is complete, move the card onward with
the devflow_transition tool (register deliverables first with devflow_attach_artifact);
if you cannot proceed, move it to "blocked" with a reason instead of guessing.`)
    started[0].settle(COMPLETED)
  })

  it('renders a sections-only spec without a frontmatter fence', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0004-sections', AT_READY)
    const { started } = await boot(
      { ready: { provider: 'stub', produces: 'review' } },
      { review: { sections: ['Verdict'] } },
    )
    await until(() => started.length === 1, 'the sections-only dispatch')
    expect(started[0].prompt).toContain('## Verdict')
    expect(started[0].prompt).not.toContain('<value>')
    started[0].settle(COMPLETED)
  })

  it('degrades to the bare registration instruction when the spec service is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0005-bare', AT_READY)
    const { started } = await boot({ ready: { provider: 'stub', produces: 'design' } })
    await until(() => started.length === 1, 'the untemplated dispatch')
    expect(started[0].prompt).toContain('This stage\'s deliverable is a "design" artifact.')
    expect(started[0].prompt).toContain('devflow_attach_artifact\'s kind + content form (kind "design")')
    expect(started[0].prompt).not.toContain('shaped like')
    started[0].settle(COMPLETED)
  })

  it('degrades the same way for a kind the present service declares without structure', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0006-structureless', AT_READY)
    const { started } = await boot(
      { ready: { provider: 'stub', produces: 'design' } },
      { design: {} },
    )
    await until(() => started.length === 1, 'the structureless dispatch')
    expect(started[0].prompt).toContain('This stage\'s deliverable is a "design" artifact.')
    expect(started[0].prompt).not.toContain('shaped like')
    started[0].settle(COMPLETED)
  })

  it('dispatches without an unreadable input artifact, warning instead of blocking', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0007-unreadable', [
      '{"rev":1,"at":"t1","type":"created","by":{"kind":"human"}}',
      '{"rev":2,"at":"t2","type":"transition","from":"draft","to":"designing"}',
      '{"rev":3,"at":"t3","type":"artifact","path":"artifacts/3-review.md","stage":"designing","kind":"review"}',
      '{"rev":4,"at":"t4","type":"artifact","path":"artifacts/4-design.md","stage":"designing","kind":"design"}',
      '{"rev":5,"at":"t5","type":"transition","from":"designing","to":"ready"}',
    ])
    await writeArtifact('0007-unreadable', '3-review.md', 'The review the disk refuses.\n')
    await writeArtifact('0007-unreadable', '4-design.md', 'The design that still feeds.\n')
    injectFsAccessDenied({
      operation: 'readFile',
      path: join(root, 'tasks', '0007-unreadable', 'artifacts', '3-review.md'),
    })
    const { started, ctx } = await boot({
      ready: { provider: 'stub', inputs: ['review', 'design'] },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await until(() => started.length === 1, 'the degraded dispatch')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'input artifact "review" (artifacts/3-review.md) on card 0007-unreadable cannot be read',
    ))
    const prompt = started[0].prompt
    expect(prompt).not.toContain('--- artifact review')
    expect(prompt).toContain('--- artifact design (rev 4) ---')
    expect(prompt).toContain('The design that still feeds.')
    started[0].settle(COMPLETED)
  })

  it.each([
    {
      label: 'an ill-formed inputs kind',
      stages: { ready: { provider: 'stub', inputs: ['Bad Kind'] } },
      message: 'stages["ready"].inputs[0] names invalid kind "Bad Kind"',
    },
    {
      label: 'an ill-formed produces kind',
      stages: { ready: { provider: 'stub', produces: '-design' } },
      message: 'stages["ready"].produces names invalid kind "-design"',
    },
  ])('fails the load on $label', async ({ stages, message }) => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(stubProvider('stub', []))
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await expect(ctx.plugin(DevflowDriver, { stages, maxConcurrentCards: 1 })).rejects.toThrow(message)
  })

  it('feeds nothing and still names the deliverable under direct application', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-devflow-driver-feed-'))
    await writeCard('0008-direct', AT_READY)
    const ctx = new Context()
    context = ctx
    const started: StartedChild[] = []
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, MODEL_ROUTE)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider(stubProvider('stub', started))
    await ctx.plugin(FilesystemDevflowStore, { root }).await()
    await ctx.inject(['devflow', 'subagents', 'agents', 'agentDefaultModel'], (child: Context) => {
      DevflowDriver.apply(child, {
        stages: { ready: { provider: 'stub', produces: 'design' } },
        maxConcurrentCards: 1,
      })
    })
    await until(() => started.length === 1, 'the direct-application dispatch')
    expect(started[0].prompt).toContain('This stage\'s deliverable is a "design" artifact.')
    expect(started[0].prompt).not.toContain('--- artifact')
    started[0].settle(COMPLETED)
  })
})
