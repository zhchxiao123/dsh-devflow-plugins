// Board transport races and stale-data behavior live below the views.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createBoardBinding } from '../src/client/binding.ts'

function context(): ClientContext {
  return {
    sessions: { list: { getSnapshot: () => ({ ids: [] }) } },
  } as unknown as ClientContext
}

function response(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('board binding refresh', () => {
  it('preserves a settled board when a later envelope refuses the read', async () => {
    const answers = [
      { ok: true, value: [] },
      { ok: false, error: { code: 'internal', message: 'temporarily unavailable' } },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(answers.shift()))))
    const binding = createBoardBinding(context(), () => 'ses-one')

    await binding.refresh()
    await binding.refresh()

    expect(binding.board.getSnapshot()).toEqual({ status: 'ready', cards: [] })
  })

  it('ignores a rejected older request after a newer refresh has settled', async () => {
    let rejectOlder: ((reason: Error) => void) | undefined
    const older = new Promise<Response>((_resolve, reject) => { rejectOlder = reject })
    const fetch = vi.fn()
      .mockReturnValueOnce(older)
      .mockResolvedValueOnce(response({ ok: true, value: [] }))
    vi.stubGlobal('fetch', fetch)
    const binding = createBoardBinding(context(), () => undefined)

    const first = binding.refresh()
    const second = binding.refresh()
    await second
    rejectOlder?.(new Error('late network failure'))
    await first

    expect(binding.board.getSnapshot()).toEqual({ status: 'ready', cards: [] })
  })
})
