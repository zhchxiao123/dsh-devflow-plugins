import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { archiveRun } from '../src/report-archive.ts'

const runId = '12345678-1234-1234-1234-123456789abc'
const card = '0001-check'
let root: string
let workspace: string
let output: string
let source: string
let record: Record<string, unknown>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-archive-')))
  workspace = join(root, 'project'); output = join(root, 'private'); source = join(output, runId)
  await mkdir(join(workspace, '.devflow/tasks', card), { recursive: true })
  await writeFile(join(workspace, '.devflow/tasks', card, 'card.md'), '# Card')
  await mkdir(source, { recursive: true })
  record = { version: 1, runId, card, status: 'passed', cleanup: 'confirmed', identity: { workspace }, results: [{ report: 'case-0.html', screenshot: 'case-0.png' }] }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(record))
  await writeFile(join(source, 'test-report.md'), '# Report\n\n[HTML](file:///private/report.html)\n')
  await writeFile(join(source, 'case-0.html'), '<!doctype html><h1>redacted SDK dump with embedded images</h1>')
  await writeFile(join(source, 'case-0.png'), Buffer.from([1, 2, 3]))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const archive = () => archiveRun(workspace, output, card, runId)
const save = () => writeFile(join(source, 'manifest.json'), JSON.stringify(record))

it('copies only published assets into a self-contained card directory; repeat does not overwrite', async () => {
  await mkdir(join(source, 'tmp')); await writeFile(join(source, 'tmp/auth.json'), 'secret')
  const result = await archive()
  expect(result.purpose).toBe('acceptance')
  expect((await readdir(result.directory)).sort()).toEqual(['case-0.html', 'case-0.png', 'report.html', 'test-report.md'])
  expect(await readFile(join(result.directory, 'case-0.html'), 'utf8')).toBe(await readFile(join(source, 'case-0.html'), 'utf8'))
  expect(await readFile(join(result.directory, 'report.html'), 'utf8')).toContain('href="case-0.html"')
  expect(await readFile(join(result.directory, 'test-report.md'), 'utf8')).not.toContain('file:///private')
  expect(result.attachment).toContain(`](midscene/${runId}/case-0.html)`)
  expect(await archive()).toEqual(result)
  await writeFile(join(result.directory, 'case-0.html'), 'user edit')
  await expect(archive()).rejects.toThrow('ARCHIVE_CONFLICT')
  expect(await readFile(join(result.directory, 'case-0.html'), 'utf8')).toBe('user edit')
})
it('archives terminal exploration reports and screenshots without copying diagnostics or private state', async () => {
  await mkdir(join(source, 'reports')); await mkdir(join(source, 'screenshots'))
  await writeFile(join(source, 'reports/observed.html'), '<html>observed</html>')
  await writeFile(join(source, 'screenshots/screenshot-test.jpg'), 'image')
  await writeFile(join(source, 'exploration.json'), JSON.stringify({ runId, workspace, purpose: 'exploration', status: 'observed', cleanup: 'confirmed', output: 'private diagnostics', artifacts: ['exploration.json', 'reports/observed.html', 'screenshots/screenshot-test.jpg'] }))
  const result = await archive()
  expect(result.purpose).toBe('exploration')
  expect(result.attachment).toContain('does not satisfy formal acceptance')
  expect(result.attachment).not.toContain('private diagnostics')
  expect(await readFile(join(result.directory, 'reports/observed.html'), 'utf8')).toContain('observed')
})
it('archives only the summary when cleanup or secret redaction is unconfirmed', async () => {
  record.cleanup = 'unknown'; await save()
  await rm(join(source, 'case-0.html'))
  const result = await archive()
  expect(await readdir(result.directory)).toEqual(['report.html', 'test-report.md'])
  expect(result.attachment).toContain('withheld')
})
it.each(['../escape', '0001-check/../../other'])('rejects invalid card %s', async (value) => {
  await expect(archiveRun(workspace, output, value, runId)).rejects.toThrow('Invalid Midscene card')
})
it('rejects invalid run ids and nonexistent cards', async () => {
  await expect(archiveRun(workspace, output, card, '../private')).rejects.toThrow('Invalid Midscene card')
  await expect(archiveRun(workspace, output, '0002-missing', runId)).rejects.toThrow()
})
it.each([
  { runId: 'another' }, { identity: { workspace: '/another' } }, { status: 'running' }, { version: 2 }, { card: '0002-other' }, { identity: null },
  { results: {} }, { results: [null] }, { results: [{ report: 5 }] }, { results: [{ report: 'tmp/auth.json' }] }, { results: [{ screenshot: '../secret.png' }] },
])('rejects malformed or foreign durable evidence %j', async (change) => {
  Object.assign(record, change); await save()
  await expect(archive()).rejects.toThrow()
})
it('permits a terminal run with no case assets', async () => {
  record.results = [{ status: 'infrastructure-error' }]; record.status = 'infrastructure-error'; await save()
  expect((await archive()).attachment).toContain('Local reports')
})
it.each([null, [], { purpose: 'bad' }, { artifacts: null }, { artifacts: [12] }, { artifacts: ['tmp/auth.json'] }])('rejects unsafe exploration records %j', async (change) => {
  const valid = { runId, workspace, purpose: 'exploration', status: 'observed', cleanup: 'confirmed', artifacts: [] }
  await writeFile(join(source, 'exploration.json'), JSON.stringify(change === null || Array.isArray(change) ? change : { ...valid, ...change }))
  await expect(archive()).rejects.toThrow()
})
it('rejects symlinks in source asset directories and files', async () => {
  await rm(join(source, 'case-0.html')); await symlink(join(source, 'case-0.png'), join(source, 'case-0.html'))
  await expect(archive()).rejects.toThrow('symbolic links')
})
it('rejects aliased run directories and destination ancestors without writing outside the card', async () => {
  const elsewhere = join(root, 'elsewhere'); await mkdir(elsewhere)
  await symlink(elsewhere, join(workspace, '.devflow/tasks', card, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(archive()).rejects.toThrow('symbolic links')
  expect(await readdir(elsewhere)).toEqual([])
  await rm(source, { recursive: true }); await symlink(elsewhere, source, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(archive()).rejects.toThrow('symbolic links')
})
it('rejects empty and nonregular assets before publishing', async () => {
  await writeFile(join(source, 'case-0.html'), '')
  await expect(archive()).rejects.toThrow('bounded nonempty')
  await rm(join(source, 'case-0.html')); await mkdir(join(source, 'case-0.html'))
  await expect(archive()).rejects.toThrow('bounded nonempty')
})
it('refuses an asset list beyond the fixed archive entry ceiling', async () => {
  record.results = Array.from({ length: 1001 }, () => ({ report: 'case-0.html' })); await save()
  await expect(archive()).rejects.toThrow('Unpublished')
})
