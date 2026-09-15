/** Read the pinned CLI's structured assertion outcome; exit status alone also covers transport failures. */
import { readdir, readFile, lstat, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { publishReportHtml } from './report-html.ts'
import { parseDumpScript } from '@midscene/core/dump'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Only an actually finished Assert task with a boolean result proves a visual verdict. */
export async function assertionVerdict(directory: string, prompt: string): Promise<boolean | undefined> {
  let verdict: boolean | undefined
  const reports = join(directory, 'midscene', 'report')
  for (const file of await readdir(reports)) {
    if (!file.endsWith('.html')) continue
    const path = join(reports, file)
    const info = await lstat(path)
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Invalid official report')
    const dump = record(JSON.parse(parseDumpScript(await readFile(path, 'utf8'))) as unknown)
    if (!Array.isArray(dump?.executions)) continue
    for (const rawExecution of dump.executions) {
      const execution = record(rawExecution)
      if (!Array.isArray(execution?.tasks)) continue
      for (const rawTask of execution.tasks) {
        const task = record(rawTask)
        if (task?.type === 'Insight' && task.subType === 'Assert' && task.status === 'finished'
          && record(task.param)?.dataDemand === prompt && typeof task.output === 'boolean') verdict = task.output
      }
    }
  }
  return verdict
}

/** Scrub configured secret values from textual CLI artifacts before exposing their paths. */
export async function redactArtifacts(directory: string, redact: (text: string) => string): Promise<void> {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, file.name)
    if (file.isDirectory()) await redactArtifacts(path, redact)
    else if (file.isFile() && ['.html', '.json', '.jsonl', '.md', '.txt', '.log'].includes(extname(file.name))) {
      const before = await readFile(path, 'utf8')
      const after = redact(before)
      if (before !== after) await writeFile(path, after, { mode: 0o600 })
    }
  }
}

/** Publish a closed list of reports and screenshots, excluding browser profiles and endpoint files. */
export async function explorationArtifacts(directory: string): Promise<string[]> {
  const artifacts = ['exploration.json']
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true, mode: 0o700 })
  for (const file of await readdir(join(directory, 'tmp'), { withFileTypes: true })) {
    if (!file.isFile() || !/^screenshot-[\w-]+\.(png|jpeg|jpg)$/.test(file.name)) continue
    await copyFile(join(directory, 'tmp', file.name), join(shots, file.name))
    artifacts.push(`screenshots/${file.name}`)
  }
  let reports: string[]
  try { reports = await readdir(join(directory, 'midscene', 'report')) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    return artifacts
  }
  const published = join(directory, 'reports')
  await mkdir(published, { recursive: true, mode: 0o700 })
  for (const name of reports) if (name.endsWith('.html') && (await lstat(join(directory, 'midscene', 'report', name))).isFile()) {
    await publishReportHtml(join(directory, 'midscene', 'report', name), join(published, name))
    artifacts.push(`reports/${name}`)
  }
  return artifacts
}
