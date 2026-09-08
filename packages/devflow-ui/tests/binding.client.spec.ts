// Board transport races and stale-data behavior live below the views.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import { createBoardBinding } from '../src/client/binding.ts'

function context(): ClientContext {
  return {
    sessions: { list: { getSnapshot: () => ({ ids: [] }) } },
  } as unknown as ClientContext
}

function response(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response
}

/** Drain the read-face promise chain started by the void detail intent. */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('board binding refresh', () => {
  it('turns an initial HTTP failure into the explicit error state', async () => {
    const fetch = vi.fn(() => Promise.resolve({ ok: false, status: 503 } as Response))
    vi.stubGlobal('fetch', fetch)
    const binding = createBoardBinding(context(), 'ses-one')

    await binding.refresh()

    expect(binding.board.getSnapshot()).toEqual({ status: 'error', cards: undefined })
    expect(fetch).toHaveBeenCalledWith('/devflow/api/list', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'ses-one' }),
    }))
  })

  it('preserves a settled board when a later envelope refuses the read', async () => {
    const answers = [
      { ok: true, value: [] },
      { ok: false, error: { code: 'internal', message: 'temporarily unavailable' } },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response(answers.shift()))))
    const binding = createBoardBinding(context(), 'ses-one')

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
    const binding = createBoardBinding(context(), 'ses-one')

    const first = binding.refresh()
    const second = binding.refresh()
    await second
    rejectOlder?.(new Error('late network failure'))
    await first

    expect(binding.board.getSnapshot()).toEqual({ status: 'ready', cards: [] })
  })

  it('preserves a settled board after a later transport failure', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: true, value: [] }))
      .mockRejectedValueOnce(new Error('wire down'))
    vi.stubGlobal('fetch', fetch)
    const binding = createBoardBinding(context(), 'ses-one')

    await binding.refresh()
    await binding.refresh()

    expect(binding.board.getSnapshot()).toEqual({ status: 'ready', cards: [] })
  })

  it('closes a current detail when the read is refused or fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, error: { code: 'not-found', message: 'gone' } }))
      .mockRejectedValueOnce(new Error('wire down'))
    vi.stubGlobal('fetch', fetch)
    const binding = createBoardBinding(context(), 'ses-one')

    binding.openCardDetail(DevflowCardId('0001-gone'))
    await flush()
    expect(binding.detail.getSnapshot().id).toBeUndefined()

    binding.openCardDetail(DevflowCardId('0002-failed'))
    await flush()
    expect(binding.detail.getSnapshot().id).toBeUndefined()
  })

  it('ignores a detail settlement superseded by closing the sheet', async () => {
    let settle: ((value: Response) => void) | undefined
    const pending = new Promise<Response>((resolve) => { settle = resolve })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const binding = createBoardBinding(context(), 'ses-one')

    binding.openCardDetail(DevflowCardId('0001-late'))
    binding.closeCardDetail()
    settle?.(response({ ok: false, error: { code: 'not-found', message: 'late' } }))
    await flush()

    expect(binding.detail.getSnapshot().id).toBeUndefined()
  })

  it('ignores a detail failure superseded by closing the sheet', async () => {
    let fail: ((reason: Error) => void) | undefined
    const pending = new Promise<Response>((_resolve, reject) => { fail = reject })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const binding = createBoardBinding(context(), 'ses-one')

    binding.openCardDetail(DevflowCardId('0001-late-failure'))
    binding.closeCardDetail()
    fail?.(new Error('late failure'))
    await flush()

    expect(binding.detail.getSnapshot().id).toBeUndefined()
  })
})
