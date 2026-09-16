/** Run the pinned official CLI against an owned browser or an explicit borrowed connection. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserServer } from 'playwright'
import type { AcceptanceProfile } from './config.ts'
import type { ModelEnvironment } from './model.ts'
import { redactSecret } from './secret-redaction.ts'
import { within } from './identity.ts'
import { childEnvironment } from './environment.ts'
import { writeExplorationOwnership } from './recovery.ts'
import type { ExplorationOwnership } from './types.ts'
import { cleanupOfficialProxy } from './official-proxy.ts'
import { terminateOwnedTree } from './process-tree.ts'
import { parseStorageState, readPrivateJson } from './auth-state.ts'
import { assertionVerdict, redactArtifacts, explorationArtifacts } from './official-evidence.ts'

const borrowed = new Set<string>()

export interface BrowserRequest { prompt?: string; assertion?: string }
export interface BrowserResult {
  runId: string
  status: 'running' | 'passed' | 'observed' | 'assertion-failed' | 'infrastructure-error' | 'cancelled'
  purpose: 'exploration'
  workspace: string
  artifacts: string[]
  directory: string
  cleanup: 'confirmed' | 'unknown'
  output: string
}

/** Execute one CLI command without shell interpolation, retaining a bounded output tail. */
export async function invokeOfficial(
  args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, cleanupMs: number,
  onSpawn?: (pid: number, script: string) => Promise<void>,
): Promise<{ code: number | null; output: string }> {
  signal.throwIfAborted()
  const require = createRequire(import.meta.url)
  const cli = join(dirname(require.resolve('@midscene/web')), '../../bin/midscene-web')
  const child = spawn(process.execPath, [cli, ...args], {
    cwd, env: childEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-131072) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let cleanup: Promise<void> | undefined
  const stop = () => {
    if (child.pid && !cleanup) cleanup = terminateOwnedTree(child.pid, undefined, cleanupMs)
    cleanup?.catch(() => { /* The awaited cleanup below reports failure. */ })
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    const [code] = await Promise.all([completion, child.pid && onSpawn ? onSpawn(child.pid, cli) : undefined])
    await cleanup
    return { code, output }
  } catch (error) {
    stop()
    await cleanup
    throw error
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** Isolated exploration does not mint formal completion evidence. */
export async function exploreBrowser(
  profile: AcceptanceProfile, request: BrowserRequest, model: ModelEnvironment,
  signal: AbortSignal, progress: (text: string) => void,
): Promise<BrowserResult> {
  const runId = randomUUID()
  await mkdir(profile.output, { recursive: true, mode: 0o700 })
  const output = await realpath(profile.output)
  if (within(await realpath(profile.workspace), output)) throw new Error('Output must be outside workspace')
  const directory = join(output, runId)
  await mkdir(directory, { mode: 0o700 })
  const temp = join(directory, 'tmp')
  await mkdir(temp, { mode: 0o700 })
  const environment = {
    ...model.environment, TMPDIR: temp, TMP: temp, TEMP: temp,
    MIDSCENE_RUN_DIR: join(directory, 'midscene'),
  }
  const result: BrowserResult = { runId, purpose: 'exploration', workspace: await realpath(profile.workspace), artifacts: [], status: 'running', directory, cleanup: 'unknown', output: '' }
  const persist = () => writeFile(join(directory, 'exploration.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  await persist()
  let server: BrowserServer | undefined
  const secrets: string[] = []
  const redact = (text: string) => secrets.reduce((value, secret) => redactSecret(value, secret), model.redact(text))
  const expiresAt = Date.now() + profile.timeoutMs
  const deadline = AbortSignal.timeout(profile.timeoutMs)
  const exhausted = new AbortController()
  const active = AbortSignal.any([signal, deadline, exhausted.signal])
  const remaining = () => {
    active.throwIfAborted()
    const timeout = expiresAt - Date.now()
    if (timeout <= 0) {
      exhausted.abort(new Error('Browser execution timed out'))
      active.throwIfAborted()
    }
    return timeout
  }
  let flags = profile.browserMode === 'bridge' ? ['--bridge'] : ['--cdp', profile.cdpEndpoint ?? '']
  const borrowedKey = profile.browserMode === 'puppeteer' ? undefined : profile.cdpEndpoint ?? 'local-chrome-bridge'
  let lease = false
  const ownership: ExplorationOwnership = { version: 1, ownerPid: process.pid, browserMode: profile.browserMode,
    ...(profile.cdpEndpoint ? { endpoint: profile.cdpEndpoint } : {}),
  }
  const commandStarted = async (pid: number, script: string) => {
    ownership.commandPid = pid
    ownership.commandScript = script
    await writeExplorationOwnership(temp, ownership)
  }
  try {
    if (borrowedKey) {
      if (borrowed.has(borrowedKey)) throw new Error('BROWSER_BUSY: another job owns this borrowed connection')
      borrowed.add(borrowedKey)
      lease = true
    }
    await writeExplorationOwnership(temp, ownership)
    active.throwIfAborted()
    if (profile.browserMode === 'puppeteer') {
      progress('Starting an isolated browser for the official CLI')
      const { chromium } = await import('playwright')
      server = await chromium.launchServer({ headless: true, timeout: remaining(),
        args: ['--remote-debugging-port=0'],
        ...(profile.executablePath ? { executablePath: profile.executablePath } : {}),
      })
      const userData = server.process().spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
      if (!userData) throw new Error('Official CLI browser endpoint unavailable')
      ownership.browserPid = server.process().pid ?? 0
      ownership.browserExecutable = server.process().spawnfile
      ownership.browserUserDataDir = userData
      await writeExplorationOwnership(temp, ownership)
      let port: string | undefined
      while (!port) {
        active.throwIfAborted()
        try { port = await readFile(join(userData, 'DevToolsActivePort'), 'utf8') }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          await delay(25, undefined, { signal: active })
        }
      }
      const [number, path] = port.trim().split('\n')
      if (!number || !/^\d+$/.test(number) || !path?.startsWith('/devtools/browser/')) throw new Error('Invalid owned CDP endpoint')
      const endpoint = `ws://127.0.0.1:${number}${path}`
      flags = ['--cdp', endpoint]
      ownership.endpoint = endpoint
      await writeExplorationOwnership(temp, ownership)
      const browser = await chromium.connectOverCDP(endpoint, { timeout: remaining() })
      try {
        active.throwIfAborted()
        const context = browser.contexts()[0]
        if (!context) throw new Error('Owned browser has no persistent context')
        const page = await context.newPage()
        active.throwIfAborted()
        if (profile.storageState) {
          const state = parseStorageState(await readPrivateJson(profile.storageState, await realpath(profile.workspace)), profile.targetUrl)
          secrets.push(
            ...state.cookies.map(cookie => cookie.value),
            ...state.origins.flatMap(origin => origin.localStorage.map(entry => entry.value)),
          )
          await context.addCookies(state.cookies)
          await page.addInitScript((origins) => {
            const pageGlobal = globalThis as unknown as {
              location: { origin: string }
              localStorage: { setItem(key: string, value: string): void }
            }
            for (const origin of origins) if (pageGlobal.location.origin === origin.origin)
              for (const entry of origin.localStorage) pageGlobal.localStorage.setItem(entry.name, entry.value)
          }, state.origins)
        }
        // The CLI captures immediately with no viewport override; hand it a rendered Playwright page.
        await page.goto(profile.targetUrl, { timeout: remaining() })
        await page.screenshot({ timeout: remaining() })
        active.throwIfAborted()
      } finally { await browser.close() }
    }
    const commands: string[][] = [
      profile.browserMode === 'puppeteer' ? ['connect'] : ['connect', '--url', profile.targetUrl], ['take_screenshot'],
      ...(request.prompt ? [['act', '--prompt', request.prompt]] : []),
      ...(request.assertion ? [['assert', '--prompt', request.assertion]] : []),
      ['take_screenshot'],
    ]
    for (const args of commands) {
      active.throwIfAborted()
      progress(`Official Midscene: ${args[0]}`)
      const step = await invokeOfficial([...flags, ...args], directory, environment, active, profile.cleanupTimeoutMs, commandStarted)
      result.output = (result.output + redact(step.output)).slice(-131072)
      active.throwIfAborted()
      if (step.code !== 0) {
        result.status = args[0] === 'assert' && request.assertion && await assertionVerdict(directory, request.assertion) === false
          ? 'assertion-failed' : 'infrastructure-error'
        return result
      }
      if (args[0] === 'assert' && request.assertion && await assertionVerdict(directory, request.assertion) !== true)
        throw new Error('Official CLI returned no completed visual assertion')
    }
    result.status = request.assertion ? 'passed' : 'observed'
  } catch (error) {
    result.status = active.aborted ? 'cancelled' : 'infrastructure-error'
    result.output += redact(error instanceof Error ? error.message : 'Browser execution failed')
  } finally {
    progress('Releasing browser resources')
    try {
      const releaseBrowser = async () => {
        if (server) {
          const pid = server.process().pid
          if (pid) await terminateOwnedTree(pid, undefined, profile.cleanupTimeoutMs)
          await server.close()
        } else if (lease) {
          const end = await invokeOfficial([...flags, 'disconnect'], directory, environment,
            AbortSignal.timeout(profile.cleanupTimeoutMs), profile.cleanupTimeoutMs, commandStarted)
          if (end.code !== 0) throw new Error('Borrowed browser disconnect failed')
        }
      }
      // Stop the proxy before its upstream so the SDK cannot remove its PID file mid-read.
      const cleanup: PromiseSettledResult<void>[] = await Promise.allSettled(
        flags[0] === '--cdp' && flags[1] ? [cleanupOfficialProxy(temp, flags[1], profile.cleanupTimeoutMs)] : [],
      )
      cleanup.push(...await Promise.allSettled([releaseBrowser()]))
      const failure = cleanup.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected')
        throw failure.reason instanceof Error ? failure.reason : new Error('Browser or proxy cleanup unconfirmed')
      result.cleanup = 'confirmed'
    } catch (error) {
      result.cleanup = 'unknown'
      result.status = 'infrastructure-error'
      result.output += '\nCleanup failed: ' + redact(String(error))
    }
    if (active.aborted && result.status !== 'infrastructure-error') result.status = 'cancelled'
    if (borrowedKey && lease) borrowed.delete(borrowedKey)
    try {
      await redactArtifacts(directory, redact)
      result.artifacts = await explorationArtifacts(directory)
    } catch {
      result.status = 'infrastructure-error'
      result.artifacts = []
      result.output = 'REPORT_UNAVAILABLE: artifacts could not be safely published'
    }
    await persist()
  }
  return result
}
