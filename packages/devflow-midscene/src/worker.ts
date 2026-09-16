/** Owns Chromium and the SDK in a killable process; only finite progress and results cross IPC. */
import type { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { Browser, BrowserServer } from 'playwright'
import { fileURLToPath } from 'node:url'
import { terminateOwnedTree } from './process-tree.ts'
import { parseStorageState } from './auth-state.ts'
import { checkBuild } from './build-probe.ts'
import { publishReportHtml } from './report-html.ts'
import { redactSecret } from './secret-redaction.ts'
import { parseSuite } from './suite.ts'
import { isAbsolute } from 'node:path'
import type { CaseResult, WorkerInput } from './types.ts'

/** The dedicated worker process owns these lifecycle and IPC operations. */
export interface WorkerHost extends Pick<EventEmitter, 'on' | 'once' | 'removeListener'> {
  cwd(): string
  send?: (event: unknown, acknowledge: (error: Error | null) => void) => unknown
  connected?: boolean
  disconnect(): void
}

/** Execute one browser suite; publishing is supplied by the IPC owner or an in-process test host. */
export async function runWorker(
  input: WorkerInput, send: (event: unknown) => void, lifecycle: Pick<EventEmitter, 'on' | 'removeListener'>,
): Promise<void> {
  let browser: Browser | undefined
  let browserServer: BrowserServer | undefined
  const control = { stopped: false }
  const isStopped = (): boolean => control.stopped
  let cleanupFailed = false
  const stop = async () => {
    control.stopped = true
    try {
      await browserServer?.close()
    } catch {
      cleanupFailed = true
    }
  }
  const onStop = () => {
    void stop()
  }
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'cancel')
      send({ type: 'infrastructure-error' })
    onStop()
  }
  lifecycle.on('message', onMessage)
  lifecycle.on('SIGTERM', onStop)
  lifecycle.on('SIGINT', onStop)
  const onDisconnect = () => {
    onStop()
    // Parent death removes its escalation timer, so the worker owns this fallback.
    setTimeout(() => {
      const helper = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./cli' + extname(fileURLToPath(import.meta.url)), import.meta.url)),
          '--terminate-tree',
          String(process.pid),
          String(browserServer?.process().pid ?? 0),
        ],
        { detached: true, stdio: 'ignore', env: process.env },
      )
      helper.unref()
    }, input.cleanupTimeoutMs)
  }
  lifecycle.on('disconnect', onDisconnect)
  try {
    const { chromium } = await import('playwright')
    const { PlaywrightAgent } = await import('@midscene/web/playwright')
    if (isStopped()) return
    browserServer = await chromium.launchServer({
      headless: true,
      ...(input.executablePath ? { executablePath: input.executablePath } : {}),
    })
    send({ type: 'browser-owned', pid: browserServer.process().pid })
    browser = await chromium.connect(browserServer.wsEndpoint())
    if (isStopped()) return
    const stateOptions = input.storageState ? { storageState: input.storageState } : {}
    const probe = await browser.newContext(stateOptions)
    const instance = await checkBuild(probe.request, input.suite)
    send({ type: 'build-verified', ...(instance ? { targetInstanceId: instance } : {}) })
    for (const [index, item] of input.suite.cases.entries()) {
      if (isStopped()) break
      send({ type: 'case-start', index })
      const context = await browser.newContext(stateOptions)
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (route.request().isNavigationRequest() && url.origin !== new URL(input.suite.baseUrl).origin)
          await route.abort()
        else await route.continue()
      })
      const page = await context.newPage()
      const agent = new PlaywrightAgent(page, {
        cache: false,
        generateReport: true,
        autoPrintReportMsg: false,
        reportFileName: `case-${index}`,
        replanningCycleLimit: input.maxSteps,
        onLLMUsage: (usage) => {
          send({
            type: 'usage',
            promptTokens: usage.prompt_tokens ?? null,
            completionTokens: usage.completion_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
          })
        },
      })
      const result: CaseResult = { id: item.id, status: 'passed', completedSteps: 0, passedAssertions: 0 }
      try {
        for (const [stepIndex, step] of item.steps.entries()) {
          if (isStopped()) throw new Error('Stopped')
          send({ type: 'step-start', index, stepIndex, kind: step.kind })
          switch (step.kind) {
            case 'goto': {
              const navigation = await page.goto(new URL(step.path, input.suite.baseUrl).href)
              if (navigation && [401, 403].includes(navigation.status())) throw new Error('Authentication required')
              break
            }
            case 'act':
              await agent.aiAct(step.prompt)
              break
            case 'assert':
              try {
                await agent.aiAssert(step.prompt)
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.cause === undefined &&
                  error.message.startsWith('Assertion failed: ')
                )
                  result.status = 'assertion-failed'
                throw error
              }
              result.passedAssertions++
              break
            case 'text':
              if ((await page.locator(step.selector).innerText()) !== step.expected) {
                result.status = 'assertion-failed'
                throw new Error('Text assertion failed')
              }
              result.passedAssertions++
              break
          }
          result.completedSteps++
          send({ type: 'step-complete', index, stepIndex })
        }
      } catch {
        if (result.status !== 'assertion-failed') result.status = 'infrastructure-error'
      } finally {
        try {
          const screenshot = `case-${index}.png`
          await page.screenshot({ path: join(input.runDir, screenshot), fullPage: true })
          result.screenshot = screenshot
        } catch {
          if (!isStopped()) result.status = 'infrastructure-error'
        }
        try {
          await agent.destroy()
          if (agent.reportFile) {
            const destination = `case-${index}.html`
            await publishReportHtml(agent.reportFile, join(input.runDir, destination))
            result.report = destination
          }
        } catch {
          result.status = 'infrastructure-error'
        }
        try {
          await context.close()
        } catch {
          cleanupFailed = true
        }
      }
      if (!result.report && result.status === 'passed') result.status = 'infrastructure-error'
      send({ type: 'case-complete', result })
      if (result.status === 'infrastructure-error') break
    }
    if (!isStopped() && await checkBuild(probe.request, input.suite) !== instance) throw new Error('Build instance changed')
    await probe.close()
  } catch {
    send({ type: 'infrastructure-error' })
  } finally {
    await stop()
    // Reports can include model diagnostics. Strip configured secrets before exposing any raw HTML.
    const secrets = Object.entries(process.env).flatMap(([key, value]) =>
      /KEY|TOKEN|PASSWORD|SECRET/i.test(key) && value ? [value] : [],
    )
    const stateSecrets = [
      ...(input.storageState?.cookies ?? []).map(cookie => cookie.value),
      ...(input.storageState?.origins ?? []).flatMap(origin => origin.localStorage.map(entry => entry.value)),
    ].filter(Boolean)
    try {
      const { readdir } = await import('node:fs/promises')
      for (const entry of await readdir(input.runDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(html|json|jsonl|txt|log)$/.test(entry.name)) continue
        const path = join(entry.parentPath, entry.name)
        let content = await readFile(path, 'utf8')
        for (const secret of [...secrets, ...stateSecrets]) content = redactSecret(content, secret)
        await writeFile(path, content, { mode: 0o600 })
      }
    } catch {
      cleanupFailed = true
    }
    send({ type: 'finished', cleanup: cleanupFailed ? 'unknown' : 'confirmed' })
    lifecycle.removeListener('message', onMessage)
    lifecycle.removeListener('SIGTERM', onStop)
    lifecycle.removeListener('SIGINT', onStop)
    lifecycle.removeListener('disconnect', onDisconnect)
  }
}
/** The parent is trusted to choose the run directory; IPC still validates the durable boundary. */
function workerInput(value: unknown, cwd: string): WorkerInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid worker input')
  const v = value as Record<string, unknown>
  if (
    typeof v.runDir !== 'string' ||
    !isAbsolute(v.runDir) ||
    v.runDir !== cwd ||
    !Number.isSafeInteger(v.maxSteps) ||
    Number(v.maxSteps) <= 0 ||
    !Number.isSafeInteger(v.cleanupTimeoutMs) ||
    Number(v.cleanupTimeoutMs) <= 0 ||
    (v.executablePath !== undefined && typeof v.executablePath !== 'string')
  )
    throw new Error('Invalid worker input')
  return {
    suite: parseSuite(v.suite, Number(v.maxSteps)),
    runDir: v.runDir,
    maxSteps: Number(v.maxSteps),
    cleanupTimeoutMs: Number(v.cleanupTimeoutMs),
    ...(v.storageState === undefined ? {} : {
      storageState: parseStorageState(v.storageState, parseSuite(v.suite, Number(v.maxSteps)).baseUrl),
    }),
    ...(typeof v.executablePath === 'string' ? { executablePath: v.executablePath } : {}),
  }
}
/** Serve the private process entry used by the public CLI. Fatal boundary failures reject. */
export async function workerMain(args: string[], host: WorkerHost = process): Promise<void> {
  if (args[0] === '--terminate-tree') {
    if (Number(args[1]) !== process.ppid) throw new Error('Invalid owned process')
    const browserPid = Number(args[2])
    await terminateOwnedTree(process.ppid, browserPid > 1 ? browserPid : undefined)
    return
  }
  if (args[0] !== '--worker' || !host.send) throw new Error('Worker requires IPC')
  await new Promise<void>((resolve, reject) => {
    host.once('message', (message: unknown) => {
      void (async () => {
        try {
          const input = workerInput(message, host.cwd())
          await mkdir(input.runDir, { recursive: true, mode: 0o700 })
          await runWorker(input, (event) => {
            host.send?.(event, () => { /* Parent-disconnect cleanup owns a lost channel. */ })
          }, host)
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Worker failed', { cause: error }))
        } finally {
          if (host.connected) host.disconnect()
        }
      })()
    })
  })
}
