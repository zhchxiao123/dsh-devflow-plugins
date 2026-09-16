/** A killed host leaves an actual official CLI request; explicit recovery must stop it without replay. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { recoverExploration } from '../src/recovery.ts'
import { processAlive, terminateCommandMatch } from '../src/official-proxy.ts'
import { startModelFixture } from './support.ts'

it('recovers a real host killed during official model work and closes recorded processes', async () => {
  const fixture = await startModelFixture()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'midscene-recovery-runtime-')))
  const output = root + '-results'
  const profile = Config({ profiles: { test: {
    workspace: root, output, targetUrl: fixture.baseUrl, model: 'gpt-4o', family: 'gpt-5', baseUrl: fixture.baseUrl + '/v1',
    credentialRef: 'TEST_KEY', timeoutMs: 60000,
  } } }).profiles.test
  if (!profile) throw new Error('Missing profile')
  const script = join(root, 'host.mjs')
  const source = new URL('../src/browser.ts', import.meta.url).href
  await writeFile(script, `import { exploreBrowser } from ${JSON.stringify(source)};
const profile = ${JSON.stringify(profile)};
const model = { capability: 'unknown', environment: { MIDSCENE_MODEL_API_KEY: 'fixture-token-secret', MIDSCENE_MODEL_NAME: 'gpt-4o', MIDSCENE_MODEL_FAMILY: 'gpt-5', MIDSCENE_MODEL_BASE_URL: profile.baseUrl }, redact: text => text.replaceAll('fixture-token-secret', '[REDACTED]') };
const result = await exploreBrowser(profile, { assertion: 'wait for model' }, model, new AbortController().signal, text => process.stderr.write(text + '\\n'));
process.stderr.write(JSON.stringify(result));
`)
  fixture.state.answer = 'hang'
  let ready!: () => void
  const requested = new Promise<void>((resolve) => { ready = resolve })
  fixture.state.onRequest = ready
  const host = spawn(process.execPath, ['--import', 'tsx/esm', script], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  host.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  const exited = new Promise<void>((resolve) => { host.once('exit', () => { resolve() }) })
  let metadata: {
    commandPid: number
    commandScript: string
    browserPid: number
    browserExecutable: string
    browserUserDataDir: string
    endpoint: string
  } | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([requested, exited.then(() => { throw new Error('Host exited before model work: ' + stderr) }), new Promise<void>((_, reject) => { timer = setTimeout(() => { reject(new Error('Model work did not start')) }, 25000) })])
    if (timer) clearTimeout(timer)
    const runId = (await readdir(output))[0]
    if (!runId) throw new Error('No run')
    const directory = join(output, runId)
    metadata = JSON.parse(await readFile(join(directory, 'tmp', 'ownership.json'), 'utf8')) as typeof metadata
    if (!metadata) throw new Error('No ownership')
    expect(processAlive(metadata.commandPid)).toBe(true)
    host.kill('SIGKILL')
    await exited
    const result = await recoverExploration(directory, root, 5000)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'interrupted', cleanup: 'confirmed' })
    expect(processAlive(metadata.commandPid)).toBe(false)
    expect(processAlive(metadata.browserPid)).toBe(false)
  } finally {
    if (timer) clearTimeout(timer)
    host.kill('SIGKILL')
    await exited
    if (metadata) await Promise.allSettled([
      terminateCommandMatch(metadata.commandPid, [metadata.commandScript, metadata.endpoint], 5000),
      terminateCommandMatch(metadata.browserPid, [metadata.browserExecutable, '--user-data-dir=' + metadata.browserUserDataDir], 5000),
    ])
    await fixture.close()
    await rm(root, { recursive: true, force: true })
    await rm(output, { recursive: true, force: true })
  }
}, 60000)
