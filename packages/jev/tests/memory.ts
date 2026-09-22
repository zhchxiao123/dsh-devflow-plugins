// A provider double for the seam's own specs. It records what `perform` was
// handed and answers from a script, so a spec can assert what the base class
// did to a request on the way in and to answers on the way out without any
// transport in the picture.
import { Context } from '@deepseek-ai/cordis'
import JevRuntime from '@zhchxiao123/dsh-jev'
import type { Answer, JevRequest, JevResponse } from '@zhchxiao123/dsh-jev'

/** What a {@link MemoryJev} should do when asked. */
export type MemoryScript = JevResponse | ((request: JevRequest) => JevResponse | Promise<JevResponse>)

/** In-memory provider: no network, no credentials, fully scripted. */
export class MemoryJev extends JevRuntime {
  /** Every request that reached `perform`, in order. */
  readonly calls: JevRequest[] = []

  private script: MemoryScript

  constructor(ctx: Context, script: MemoryScript = { answers: {} }) {
    super(ctx)
    this.script = script
  }

  /** Swap the scripted outcome between calls. */
  setScript(script: MemoryScript): void {
    this.script = script
  }

  protected override async perform(request: JevRequest): Promise<JevResponse> {
    this.calls.push(request)
    const script = this.script
    return typeof script === 'function' ? await script(request) : script
  }
}

/** A minimal score answer, for specs that only care about the key set. */
export function scoreAnswer(score: number, confidence = 0.9): Answer {
  return { type: 'score', score, probabilities: [0, 1], confidence }
}
