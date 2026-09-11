/**
 * The evidence projection and its quotas. Every case here checks the same
 * contract from a different angle: a file that cannot ride inline is still
 * reported by path, and whatever bounded it says so. A silent cap would read
 * as "this is everything the run produced", which is the one thing the report
 * must never imply.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it } from 'vitest'
import { projectEvidence } from '../src/evidence-content.ts'
import type { EvidenceQuota } from '../src/evidence-content.ts'
import type { EvidenceFile, EvidenceReport } from '../src/types.ts'

const QUOTA: EvidenceQuota = { maxEvidenceImages: 2, maxEvidenceFiles: 3, evidenceFileBytesCap: 100 }

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** An attachment service double that records what it was asked to save. */
function fakeStore(saveImage?: (input: SaveImageAttachment) => Promise<unknown>): { store: AttachmentStore; saved: string[] } {
  const saved: string[] = []
  const store = {
    async saveImage(input: SaveImageAttachment) {
      saved.push(input.name ?? '')
      if (saveImage !== undefined) return await saveImage(input)
      return { attachmentId: `att-${input.name}`, mediaType: input.mediaType, bytes: input.data.length, width: 8, height: 6, name: input.name }
    },
  } as unknown as AttachmentStore
  return { store, saved }
}

/** Files written to a fresh workspace, returned as collected evidence entries. */
async function filesOnDisk(entries: readonly { name: string; contents: string; contentType?: string }[]): Promise<EvidenceFile[]> {
  root = await mkdtemp(join(tmpdir(), 'testenv-content-'))
  const files: EvidenceFile[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    await writeFile(path, entry.contents)
    files.push({
      name: entry.name,
      path,
      bytes: entry.contents.length,
      ...entry.contentType === undefined ? {} : { contentType: entry.contentType },
    })
  }
  return files
}

function report(files: readonly EvidenceFile[], rest: Partial<EvidenceReport> = {}): EvidenceReport {
  return { files, failures: [], diagnostics: [], ...rest }
}

describe('projectEvidence', () => {
  it('lists files by path and shows none inline without an attachment service', async () => {
    const files = await filesOnDisk([{ name: 'a.png', contents: 'x', contentType: 'image/png' }])
    const value = await projectEvidence(report(files), QUOTA, undefined)
    expect(value.files).toEqual([{ name: 'a.png', path: files[0]?.path, bytes: 1 }])
    expect(value.diagnostics).toBeUndefined()
  })

  it('mints an image for a viewable file within the size cap', async () => {
    const files = await filesOnDisk([{ name: 'a.png', contents: 'xy', contentType: 'image/png' }])
    const { store, saved } = fakeStore()
    const value = await projectEvidence(report(files), QUOTA, store)
    expect(saved).toEqual(['a.png'])
    expect(value.files?.[0]?.image).toEqual({
      attachmentId: 'att-a.png',
      mediaType: 'image/png',
      bytes: 2,
      width: 8,
      height: 6,
      name: 'a.png',
    })
  })

  it('copies only the reference fields the render needs', async () => {
    const files = await filesOnDisk([{ name: 'a.png', contents: 'x', contentType: 'image/png' }])
    const { store } = fakeStore(async () => ({
      attachmentId: 'id', mediaType: 'image/png', bytes: 1, width: 1, height: 1, originalDimensions: { width: 9, height: 9 },
    }))
    const value = await projectEvidence(report(files), QUOTA, store)
    expect(value.files?.[0]?.image).toEqual({ attachmentId: 'id', mediaType: 'image/png', bytes: 1, width: 1, height: 1 })
  })

  it('spends the inline quota on the first images and says what it did', async () => {
    const files = await filesOnDisk([
      { name: 'a.png', contents: 'x', contentType: 'image/png' },
      { name: 'b.png', contents: 'x', contentType: 'image/png' },
      { name: 'c.png', contents: 'x', contentType: 'image/png' },
    ])
    const { store, saved } = fakeStore()
    const value = await projectEvidence(report(files), QUOTA, store)
    expect(saved).toEqual(['a.png', 'b.png'])
    expect(value.files?.map(file => file.image !== undefined)).toEqual([true, true, false])
    expect(value.diagnostics).toEqual([
      '3 evidence images were found; the first 2 are shown inline and the rest are listed by path',
    ])
  })

  it('caps how many files it lists at all, and never caps silently', async () => {
    const files = await filesOnDisk([
      { name: 'a.txt', contents: 'x' },
      { name: 'b.txt', contents: 'x' },
      { name: 'c.txt', contents: 'x' },
      { name: 'd.txt', contents: 'x' },
    ])
    const value = await projectEvidence(report(files), QUOTA, undefined)
    expect(value.files).toHaveLength(3)
    expect(value.diagnostics).toEqual(['4 evidence files were found; the 3 listed here are the first by path'])
  })

  it.each([
    { label: 'a media type the service cannot show', contentType: 'application/zip', contents: 'x' },
    { label: 'a file past the size cap', contentType: 'image/png', contents: 'x'.repeat(101) },
    { label: 'a file with no media type at all', contentType: undefined, contents: 'x' },
  ])('lists $label by path without asking the service', async ({ contentType, contents }) => {
    const files = await filesOnDisk([{ name: 'a', contents, ...contentType === undefined ? {} : { contentType } }])
    const { store, saved } = fakeStore()
    const value = await projectEvidence(report(files), QUOTA, store)
    expect(saved).toEqual([])
    expect(value.files?.[0]).not.toHaveProperty('image')
  })

  it('falls back to the path when the service refuses the bytes', async () => {
    const files = await filesOnDisk([{ name: 'a.png', contents: 'x', contentType: 'image/png' }])
    const { store } = fakeStore(async () => {
      throw new Error('decoded bytes are not a PNG')
    })
    const value = await projectEvidence(report(files), QUOTA, store)
    expect(value.files?.[0]).not.toHaveProperty('image')
    expect(value.diagnostics).toEqual([
      'a.png could not be shown inline (decoded bytes are not a PNG); it is listed by path instead',
    ])
  })

  it('carries the failed cases and links each to the files it attached', async () => {
    const value = await projectEvidence(
      report([], {
        failures: [
          {
            title: 'cart › totals',
            file: 'cart.spec.ts',
            line: 4,
            column: 2,
            message: 'boom',
            snippet: '> 4 | expect(total)',
            attachments: [{ name: 'shot', path: '/tmp/shot.png', contentType: 'image/png' }],
          },
          { title: 'bare' },
        ],
      }),
      QUOTA,
      undefined,
    )
    expect(value.failures).toEqual([
      {
        title: 'cart › totals',
        file: 'cart.spec.ts',
        line: 4,
        column: 2,
        message: 'boom',
        snippet: '> 4 | expect(total)',
        attachments: ['/tmp/shot.png'],
      },
      { title: 'bare' },
    ])
  })

  it('keeps an empty block empty rather than carrying empty lists', async () => {
    expect(await projectEvidence(report([]), QUOTA, undefined)).toEqual({})
  })

  it('passes collection diagnostics through ahead of its own', async () => {
    const value = await projectEvidence(report([], { diagnostics: ['nothing matched'] }), QUOTA, undefined)
    expect(value.diagnostics).toEqual(['nothing matched'])
  })
})
