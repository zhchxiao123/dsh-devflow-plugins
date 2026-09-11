/**
 * Projection of collected evidence onto the tool's wire value, minting image
 * attachments as it goes. This is the one place that touches the attachment
 * service, because `ToolOutputDefinition.render` is a pure synchronous
 * function of the canonical value: a reference the model can look at has to
 * exist in that value before rendering starts.
 *
 * Every step degrades rather than fails. A missing attachment service, a media
 * type the service cannot normalize, a file past the size cap, a quota already
 * spent, a save that throws — each leaves the file reported by path, which is
 * all a model needs to open it. The degradation is visible in the value
 * itself: `image` present means the model can see it, absent means it must go
 * read the path.
 */

import { readFile } from 'node:fs/promises'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { EvidenceFile, EvidenceReport } from './types.ts'

/**
 * Media types the attachment service normalizes into a viewable image. This
 * restates `ImageMediaType` from `@deepseek-ai/dsh-attachment` as a runtime
 * set, because the published surface carries the union as a type only; a
 * divergence from that union is a defect in this copy.
 */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Deployment-resolved bounds on how much of a red run's evidence rides inline. */
export interface EvidenceQuota {
  /** Images carried inline; the rest are listed by path. */
  maxEvidenceImages: number
  /** Files listed at all, inline or not. */
  maxEvidenceFiles: number
  /** Largest file worth offering inline. */
  evidenceFileBytesCap: number
}

/**
 * A saved image's reference as plain JSON. The attachment service's own
 * reference carries a branded id and may carry fields this plugin never reads;
 * the canonical tool value must be lossless JSON, so the fields the render
 * needs are copied across explicitly rather than the object being passed
 * through.
 */
export interface EvidenceImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** One evidence file on the wire; `image` present means the render can show it. */
export interface EvidenceFileValue {
  name: string
  path: string
  bytes: number
  image?: EvidenceImageRef
}

/** One failed case on the wire. */
export interface FailureValue {
  title: string
  file?: string
  line?: number
  column?: number
  message?: string
  snippet?: string
  /** Paths of the files this case attached, linking a failure to its evidence. */
  attachments?: string[]
}

/** The evidence block of a failed `env_test` wire value. */
export interface EvidenceValue {
  failures?: FailureValue[]
  files?: EvidenceFileValue[]
  diagnostics?: string[]
}

/**
 * Project one collected evidence report onto its wire value.
 * @param evidence - what collection found on disk.
 * @param quota - how much of it rides inline.
 * @param store - the attachment service, or `undefined` in a composition without one.
 * @returns the wire block; empty parts stay absent.
 */
export async function projectEvidence(
  evidence: EvidenceReport,
  quota: EvidenceQuota,
  store: AttachmentStore | undefined,
): Promise<EvidenceValue> {
  const diagnostics = [...evidence.diagnostics]
  const listed = evidence.files.slice(0, quota.maxEvidenceFiles)
  if (listed.length < evidence.files.length) {
    diagnostics.push(
      `${evidence.files.length} evidence files were found; the ${listed.length} listed here are the first by path`,
    )
  }
  const files = await mintedFiles(listed, quota, store, diagnostics)
  const failures: FailureValue[] = evidence.failures.map(failure => ({
    title: failure.title,
    ...failure.file === undefined ? {} : { file: failure.file },
    ...failure.line === undefined ? {} : { line: failure.line },
    ...failure.column === undefined ? {} : { column: failure.column },
    ...failure.message === undefined ? {} : { message: failure.message },
    ...failure.snippet === undefined ? {} : { snippet: failure.snippet },
    ...failure.attachments === undefined
      ? {}
      : { attachments: failure.attachments.map(attachment => attachment.path) },
  }))
  return {
    ...failures.length === 0 ? {} : { failures },
    ...files.length === 0 ? {} : { files },
    ...diagnostics.length === 0 ? {} : { diagnostics },
  }
}

/** Every listed file, with an image reference on the ones that earned one. */
async function mintedFiles(
  listed: readonly EvidenceFile[],
  quota: EvidenceQuota,
  store: AttachmentStore | undefined,
  diagnostics: string[],
): Promise<EvidenceFileValue[]> {
  const showable = listed.filter(file => isShowable(file, quota))
  // A missing attachment service gets no diagnostic of its own: the absence of
  // `image` on every file already says it, and the same absence has other
  // causes (a text-only background job) that would make one reason a lie.
  if (store !== undefined && showable.length > quota.maxEvidenceImages) {
    diagnostics.push(
      `${showable.length} evidence images were found; the first ${quota.maxEvidenceImages} are shown inline`
      + ' and the rest are listed by path',
    )
  }
  const files: EvidenceFileValue[] = []
  let minted = 0
  for (const file of listed) {
    const inline = store !== undefined && isShowable(file, quota) && minted < quota.maxEvidenceImages
    const image = inline ? await mint(file, store, diagnostics) : undefined
    if (image !== undefined) minted += 1
    files.push({
      name: file.name,
      path: file.path,
      bytes: file.bytes,
      ...image === undefined ? {} : { image },
    })
  }
  return files
}

/** Whether the service could normalize this file at all, size included. */
function isShowable(file: EvidenceFile, quota: EvidenceQuota): boolean {
  return file.contentType !== undefined
    && (IMAGE_MEDIA_TYPES as readonly string[]).includes(file.contentType)
    && file.bytes <= quota.evidenceFileBytesCap
}

/** One saved image reference, or `undefined` with the reason recorded. */
async function mint(
  file: EvidenceFile,
  store: AttachmentStore,
  diagnostics: string[],
): Promise<EvidenceImageRef | undefined> {
  try {
    const data = await readFile(file.path)
    const ref = await store.saveImage({ data, mediaType: file.contentType as ImageMediaType, name: file.name })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    }
  } catch (error) {
    diagnostics.push(`${file.name} could not be shown inline (${message(error)}); it is listed by path instead`)
    return undefined
  }
}

function message(error: unknown): string {
  /* v8 ignore next -- fs and the attachment service reject with Errors; String() guards a hostile custom throw. */
  return error instanceof Error ? error.message : String(error)
}
