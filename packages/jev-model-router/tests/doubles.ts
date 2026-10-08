// Doubles for the three things this router reaches outside itself: the
// judgement seam, the delegation tool it governs, and the agent a delegation
// is attributed to.
//
// The judgement double is an in-memory `JevRuntime`. No provider package is
// imported anywhere in this directory, which is what makes "the backend is
// swappable" something the suite checks rather than something it assumes.
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import JevRuntime, { JevError } from '@zhchxiao123/dsh-jev'
import type { Answer, JevConfigurationStatus, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'
import type { Tier } from '@zhchxiao123/dsh-jev-model-router'

/**
 * What a {@link MemoryJev} should do when asked. A plain `Error` stands in for
 * a transport that failed outside the seam's own classification.
 */
export type JevScript = JevResponse | JevError | Error | { readonly stall: true }

/** In-memory judgement: no network, no credentials, fully scripted. */
export class MemoryJev extends JevRuntime {
  /** Every request that reached the transport, in order. */
  readonly calls: JevRequest[] = []

  private script: JevScript = { answers: {} }
  private status: JevConfigurationStatus = 'configured'
  private statusThrows = false

  /** Replace what the next judgement returns, throws, or refuses to finish. */
  setScript(script: JevScript): void {
    this.script = script
  }

  /** Replace what local configuration reports. */
  setStatus(status: JevConfigurationStatus): void {
    this.status = status
    this.statusThrows = false
  }

  /** Make the configuration resolver fail, as a credential lookup can. */
  setStatusThrows(): void {
    this.statusThrows = true
  }

  override configurationStatus(): Promise<JevConfigurationStatus> {
    if (this.statusThrows) return Promise.reject(new Error('credential resolver exploded'))
    return Promise.resolve(this.status)
  }

  protected override async perform(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    this.calls.push(request)
    if (this.script instanceof Error) throw this.script
    if ('stall' in this.script) {
      // Never settles on its own: whoever cancels first is what the spec is
      // about, so the abort has to be the real one the caller passed in.
      return await new Promise<JevResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new JevError('dsh-jev: request was aborted', 'JEV_ABORTED'))
        }, { once: true })
      })
    }
    return await Promise.resolve(this.script)
  }
}

/** A score answer, at the confidence a spec wants to test around. */
export function scoreAnswer(score: number, confidence = 0.9): Answer {
  return { type: 'score', score, confidence, probabilities: [] }
}

/** The tiers most specs route against. */
export const TIERS: Tier[] = [
  { key: 'cheap', when: 'Mechanical edits with an already-known answer.', provider: 'p', model: 'small' },
  { key: 'standard', when: 'Ordinary implementation needing a few files read.', provider: 'p', model: 'medium' },
  { key: 'deep', when: 'Cross-layer design, concurrency, or a costly wrong result.', provider: 'p', model: 'large', reasoningEffort: 'high' },
]

/** Every delegation a {@link delegationTool} received. */
export interface DelegationCall {
  readonly arguments: unknown
}

/**
 * A stand-in for the harness delegation tool: it accepts the same route fields
 * and records what reached it, so a spec can tell "the gate allowed this" from
 * "the gate denied it" by whether the body ran at all.
 *
 * @param calls - collector the tool appends each call to.
 * @param name - the tool name to register under.
 * @returns the definition.
 */
export function delegationTool(calls: DelegationCall[], name = 'subagent'): ToolDefinition {
  return defineTool({
    name,
    description: 'Delegate work to a child agent.',
    parameters: {
      description: { type: 'string', description: 'Short label.' },
      prompt: { type: 'string', required: true, description: 'What the child should do.' },
      provider: { type: 'string', description: 'Child LLM provider.' },
      model: { type: 'string', description: 'Child LLM model.' },
      reasoning_effort: { type: 'string', description: 'Child reasoning effort.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      calls.push({ arguments: args })
      return Promise.resolve('delegated')
    },
  })
}

/**
 * The tool whose presence means a route can be named at all. Only its
 * registration matters here, never its result.
 *
 * @returns the definition.
 */
export function listModelsTool(): ToolDefinition {
  return defineTool({
    name: 'list_subagent_models',
    description: 'List the child LLM routes this deployment authorizes.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('[]'),
  })
}

/**
 * A synthetic Agent: a lineage and route anchor, never prompted.
 *
 * Restated from `createGateAgent` in `@zhchxiao123/dsh-devflow-review-gate`,
 * whose copy is package-internal and therefore not importable. Nothing here
 * runs a turn, so the callbacks are inert.
 *
 * @param options - the route this agent reports as its own.
 * @param suffix - distinguishes two agents in one spec.
 * @returns the agent.
 */
export function testAgent(
  options: { provider?: string; model?: string } = {},
  suffix = '1',
): Agent {
  const id = SessionId(`jev-model-router-test-${suffix}`)
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    cwd: '/workspace',
    isSeeded: false,
  })
  const empty: readonly UserMessage[] = []
  const inbox = {
    nextTurn: empty,
    nextStep: empty,
    hasPending: false,
    clear: () => {},
    claim: (_target: InboxTarget, _turn: number): UserMessage[] => [],
    append: (_target: InboxTarget, _message: UserMessage) => {},
    prepend: (_target: InboxTarget, _message: UserMessage) => {},
    replace: (_messageId: UserMessage['id'], _newMessage: UserMessage) => false,
    remove: (_messageId: UserMessage['id']) => false,
    splice: (
      _target: InboxTarget,
      _start: number,
      _deleteCount: number,
      _inserted: UserMessage[],
    ): UserMessage[] => [],
  }
  return {
    id: session.id,
    options,
    session,
    inbox,
    status: 'idle',
    ctx: undefined as unknown as Agent['ctx'],
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}
