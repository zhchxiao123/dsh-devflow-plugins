/** Filesystem fault injection covers replacement races that real symlink fixtures cannot schedule deterministically. */
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { archiveRun } from '../src/report-archive.ts'
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) }
})
const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const runId = '12345678-1234-1234-1234-123456789abc'
let root: string
let workspace: string
let output: string
let source: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'midscene-archive-boundary-')))
  workspace = join(root, 'project'); output = join(root, 'private'); source = join(output, runId)
  await fs.mkdir(join(workspace, '.devflow/tasks/0001-card'), { recursive: true })
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(join(workspace, '.devflow/tasks/0001-card/card.md'), 'card')
  await fs.writeFile(join(source, 'manifest.json'), JSON.stringify({ version: 1, runId, card: '0001-card', status: 'passed', cleanup: 'confirmed', identity: { workspace }, results: [] }))
  await fs.writeFile(join(source, 'test-report.md'), '# Summary')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.open).mockImplementation(real.open)
  vi.mocked(fs.mkdir).mockImplementation(real.mkdir)
  await fs.rm(root, { recursive: true, force: true })
})
const archive = () => archiveRun(workspace, output, '0001-card', runId)
it('does not hide corrupt or unreadable exploration records as formal evidence', async () => {
  await fs.writeFile(join(source, 'exploration.json'), '')
  await expect(archive()).rejects.toThrow('bounded nonempty')
})
it('fails without publishing when an output directory cannot be created', async () => {
  vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(archive()).rejects.toThrow('disk unavailable')
})
it('does not mistake output permissions failures for an existing archive', async () => {
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[1] === 'wx') throw new Error('output denied')
    return real.open(...args)
  })
  await expect(archive()).rejects.toThrow('output denied')
})
it('rejects input growth between its stat and bounded read', async () => {
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await real.open(...args)
    if (String(args[0]).endsWith('test-report.md')) vi.spyOn(file, 'read').mockImplementation(async () => ({ bytesRead: 1, buffer: Buffer.alloc(1) }))
    return file
  })
  await expect(archive()).rejects.toThrow('changed while reading')
})
it('rejects replacement of a newly opened archive file before writing bytes', async () => {
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await real.open(...args)
    if (args[1] === 'wx') {
      const stat = await file.stat()
      vi.spyOn(file, 'stat').mockResolvedValue(Object.assign(stat, { ino: stat.ino + 1 }))
    }
    return file
  })
  await expect(archive()).rejects.toThrow('changed while opening')
})
it('bounds the total published bytes independently of individual report sizes', async () => {
  const results = Array.from({ length: 5 }, (_, index) => ({ report: `case-${index}.html` }))
  await fs.writeFile(join(source, 'manifest.json'), JSON.stringify({ version: 1, runId, card: '0001-card', status: 'passed', cleanup: 'confirmed', identity: { workspace }, results }))
  for (const result of results) await fs.writeFile(join(source, result.report), 'report')
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await real.open(...args)
    if (/case-\d+\.html$/.test(String(args[0]))) {
      const stat = await file.stat()
      vi.spyOn(file, 'stat').mockResolvedValue(Object.assign(stat, { size: 64 * 1024 * 1024 }))
      vi.spyOn(file, 'read').mockImplementation(async () => ({ bytesRead: 64 * 1024 * 1024, buffer: Buffer.alloc(0) }))
    }
    return file
  })
  await expect(archive()).rejects.toThrow('archive exceeds size limit')
})
