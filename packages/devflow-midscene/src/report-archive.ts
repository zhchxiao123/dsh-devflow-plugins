/** Card-local copies contain only published evidence; private worker state never crosses this boundary. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Published SDK HTML embeds its images. Bounds cover reports, not arbitrary browser profiles.
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const TERMINAL = ['passed', 'observed', 'assertion-failed', 'infrastructure-error', 'cancelled', 'timed-out', 'interrupted']
const RUN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const CARD = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/
const ASSET = /^(?:case-\d+\.(?:html|png)|reports\/[\w.-]+\.html|screenshots\/screenshot-[\w-]+\.(?:png|jpeg|jpg))$/

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Midscene evidence')
  return value as Record<string, unknown>
}
/** Reject all symlink components, including aliases that stay inside the selected root. */
async function checked(root: string, relative: string, create = false): Promise<string> {
  let path = root
  for (const part of relative.split('/')) {
    path = join(path, part)
    if (create) await mkdir(path).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    })
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('Midscene archive paths must not traverse symbolic links')
  }
  return path
}
async function bytes(root: string, relative: string): Promise<Buffer> {
  const path = await checked(root, relative)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const [info, current] = await Promise.all([file.stat(), lstat(await checked(root, relative))])
    if (!info.isFile() || !info.size || info.size > MAX_FILE_BYTES || info.dev !== current.dev || info.ino !== current.ino)
      throw new Error('Midscene evidence must be a bounded nonempty regular file')
    const buffer = Buffer.alloc(info.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size) throw new Error('Midscene evidence changed while reading')
    return buffer.subarray(0, bytesRead)
  } finally { await file.close() }
}
async function put(root: string, relative: string, data: Buffer): Promise<void> {
  const parent = dirname(relative)
  await checked(root, parent, true)
  const path = join(root, relative)
  const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return undefined
    throw error
  })
  if (!file) {
    if (!(await bytes(root, relative)).equals(data)) throw new Error('MIDSCENE_ARCHIVE_CONFLICT: existing card evidence differs')
    return
  }
  try {
    const current = await lstat(await checked(root, relative))
    const opened = await file.stat()
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Midscene archive changed while opening')
    await file.writeFile(data); await file.sync()
  } finally { await file.close() }
}
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Archive a terminal run for an existing card. Repeating identical evidence is safe; conflicts never overwrite it. */
export async function archiveRun(workspace: string, output: string, card: string, runId: string): Promise<{
  directory: string
  html: string
  markdown: string
  attachment: string
  htmlFiles: string[]
  purpose: 'acceptance' | 'exploration'
}> {
  if (!CARD.test(card) || !RUN.test(runId)) throw new Error('Invalid Midscene card or run id')
  const root = await realpath(workspace)
  await bytes(root, `.devflow/tasks/${card}/card.md`)
  const source = await checked(await realpath(output), runId)
  let exploration: Buffer | undefined
  try { exploration = await bytes(source, 'exploration.json') }
  catch (error) { if (!missing(error)) throw error }
  const record = object(JSON.parse((exploration ?? await bytes(source, 'manifest.json')).toString('utf8')))
  const purpose = exploration ? 'exploration' : 'acceptance'
  const identity = exploration ? record : object(record.identity)
  if (record.runId !== runId || identity.workspace !== root || !TERMINAL.includes(String(record.status))
    || (exploration ? record.purpose !== 'exploration' : record.version !== 1 || record.card !== card))
    throw new Error('Midscene evidence does not belong to this terminal run and card')
  let assets: string[]
  let summary: string
  if (exploration) {
    if (!Array.isArray(record.artifacts) || record.artifacts.some(path => typeof path !== 'string')) throw new Error('Invalid published exploration assets')
    assets = record.artifacts.filter((path): path is string => typeof path === 'string' && path !== 'exploration.json')
    summary = `---\ncard: ${JSON.stringify(card)}\nkind: test-report\ntitle: Midscene exploration\n---\n\n# Midscene exploration\n\n## Scope\n\nExploration only; this does not satisfy formal acceptance.\n\n## Coverage\n\nRun: ${runId}\n\n## Results\n\nStatus: **${String(record.status)}**\n\n## Conclusion\n\nHistorical exploration never authorizes card completion.\n`
  } else {
    if (!Array.isArray(record.results)) throw new Error('Invalid published acceptance results')
    assets = record.results.flatMap((value) => {
      const result = object(value)
      return [result.report, result.screenshot].filter((path): path is string => {
        if (path !== undefined && typeof path !== 'string') throw new Error('Invalid published acceptance asset')
        return typeof path === 'string'
      })
    })
    summary = (await bytes(source, 'test-report.md')).toString('utf8')
    // The runner owns this summary format. Remove external links before adding portable local ones.
    summary = summary.replace(/\[[^\]\n]*\]\([^\n]*\)/g, '')
  }
  if (assets.length > 1000 || assets.some(path => !ASSET.test(path))) throw new Error('Unpublished Midscene archive asset')
  // Worker cleanup includes secret scrubbing. Unconfirmed cleanup may retain a summary, never raw reports.
  if (record.cleanup !== 'confirmed') { assets = []; summary += '\nDetailed evidence withheld: cleanup or secret redaction was not confirmed.\n' }
  assets = [...new Set(assets)]
  const files = new Map<string, Buffer>()
  let total = 0
  for (const asset of assets) {
    const data = await bytes(source, asset)
    total += data.length
    if (total > MAX_ARCHIVE_BYTES) throw new Error('Midscene archive exceeds size limit')
    files.set(asset, data)
  }
  const relative = `.devflow/tasks/${card}/artifacts/midscene/${runId}`
  const links = (prefix: string) => ['report.html', ...assets].map(path => `[${path}](${prefix}${path})`).join('\n\n')
  const markdown = `${summary}\n## Local reports\n\n${links('')}\n`
  const html = `<!doctype html><meta charset="utf-8"><title>Midscene ${runId}</title><h1>${purpose}: ${escape(String(record.status))}</h1><pre>${escape(summary)}</pre>${assets.map(path => `<p><a href="${path}">${path}</a></p>`).join('')}\n`
  files.set('report.html', Buffer.from(html))
  files.set('test-report.md', Buffer.from(markdown))
  for (const [path, data] of files) await put(root, `${relative}/${path}`, data)
  return { htmlFiles: ['report.html', ...assets.filter(path => path.endsWith('.html'))].map(path => `artifacts/midscene/${runId}/${path}`),
    directory: join(root, relative), html: `${relative}/report.html`, markdown: `${relative}/test-report.md`,
    attachment: `${summary}\n## Local reports\n\n${links(`midscene/${runId}/`)}\n`, purpose }
}
