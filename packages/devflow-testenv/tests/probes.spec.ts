/**
 * The three readiness probes against real listeners on dynamic ports, and the
 * poller's deadline/abort classification. The http spec also pins the no-proxy
 * contract: a container-wide proxy environment must never see a readiness
 * request.
 */
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server as TcpServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { commandProbe, httpProbe, pollUntilReady, tcpProbe } from '../src/probes.ts'
import type { SpawnPlan, SpawnRunner } from '../src/types.ts'

const servers: (HttpServer | TcpServer)[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise((resolve) => { server.close(resolve) })))
})

function listen(server: HttpServer | TcpServer): Promise<number> {
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
  })
}

/** A port nothing listens on: bind, read, release. */
async function closedPort(): Promise<number> {
  const server = createTcpServer()
  const port = await listen(server)
  await new Promise((resolve) => { server.close(resolve) })
  return port
}

function anySignal(): AbortSignal {
  return new AbortController().signal
}

describe('tcpProbe', () => {
  it('answers ready once a connection opens', async () => {
    const port = await listen(createTcpServer(() => {}))
    await expect(tcpProbe({ host: '127.0.0.1', port })(anySignal())).resolves.toBe(true)
  })

  it('answers not ready when nothing listens', async () => {
    await expect(tcpProbe({ host: '127.0.0.1', port: await closedPort() })(anySignal())).resolves.toBe(false)
  })

  it('answers not ready on an already-aborted signal without connecting', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(tcpProbe({ host: '127.0.0.1', port: await closedPort() })(controller.signal)).resolves.toBe(false)
  })

  it('stops an in-flight attempt when the signal aborts', async () => {
    const port = await listen(createTcpServer(() => {}))
    const controller = new AbortController()
    const attempt = tcpProbe({ host: '127.0.0.1', port })(controller.signal)
    // Connecting takes at least one event-loop turn; a same-tick abort always wins.
    controller.abort()
    await expect(attempt).resolves.toBe(false)
  })
})

describe('httpProbe', () => {
  function serverAnswering(status: number, hits?: string[]): HttpServer {
    return createHttpServer((req, res) => {
      hits?.push(req.url ?? '')
      res.statusCode = status
      res.end()
    })
  }

  it('treats any 2xx as ready when no status is configured', async () => {
    const port = await listen(serverAnswering(204))
    await expect(httpProbe({ url: `http://127.0.0.1:${port}/healthz` })(anySignal())).resolves.toBe(true)
  })

  it('treats a non-2xx as not ready when no status is configured', async () => {
    const port = await listen(serverAnswering(503))
    await expect(httpProbe({ url: `http://127.0.0.1:${port}/healthz` })(anySignal())).resolves.toBe(false)
  })

  it('matches a configured status exactly', async () => {
    const port = await listen(serverAnswering(302))
    await expect(httpProbe({ url: `http://127.0.0.1:${port}/`, status: 302 })(anySignal())).resolves.toBe(true)
    await expect(httpProbe({ url: `http://127.0.0.1:${port}/`, status: 200 })(anySignal())).resolves.toBe(false)
  })

  it('answers not ready when the connection is refused', async () => {
    await expect(httpProbe({ url: `http://127.0.0.1:${await closedPort()}/` })(anySignal())).resolves.toBe(false)
  })

  it('answers not ready when the signal aborts the attempt', async () => {
    const port = await listen(serverAnswering(200))
    const controller = new AbortController()
    const attempt = httpProbe({ url: `http://127.0.0.1:${port}/` })(controller.signal)
    controller.abort()
    await expect(attempt).resolves.toBe(false)
  })

  it('goes direct even when proxy environment points elsewhere', async () => {
    const targetHits: string[] = []
    const targetPort = await listen(serverAnswering(204, targetHits))
    const trapHits: string[] = []
    const trapPort = await listen(serverAnswering(200, trapHits))
    const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'] as const
    const saved = new Map<string, string | undefined>(PROXY_KEYS.map(key => [key, process.env[key]]))
    for (const key of PROXY_KEYS) process.env[key] = key === 'NODE_USE_ENV_PROXY' ? '1' : `http://127.0.0.1:${trapPort}`
    try {
      await expect(httpProbe({ url: `http://127.0.0.1:${targetPort}/healthz`, status: 204 })(anySignal())).resolves.toBe(true)
    } finally {
      for (const key of PROXY_KEYS) {
        const value = saved.get(key)
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
    // A proxied request would answer 200 from the trap and be misread as
    // ready; the trap seeing nothing is the pinned contract.
    expect(targetHits).toEqual(['/healthz'])
    expect(trapHits).toEqual([])
  })
})

describe('commandProbe', () => {
  const plan: SpawnPlan = {
    argv: ['sh', '-c', 'true'],
    cwd: '/tmp',
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 100,
  }

  function runnerAnswering(outcome: SubprocessOutcome, seen: SubprocessSpawnSpec[]): SpawnRunner {
    return (spec) => {
      seen.push(spec)
      return Promise.resolve(outcome)
    }
  }

  it('is ready on exit 0 and hands the runner the plan plus the attempt signal', async () => {
    const seen: SubprocessSpawnSpec[] = []
    const controller = new AbortController()
    await expect(commandProbe(runnerAnswering({ exitCode: 0, signal: null }, seen), plan)(controller.signal)).resolves.toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ ...plan, signal: controller.signal })
  })

  it('is not ready on a non-zero exit', async () => {
    await expect(commandProbe(runnerAnswering({ exitCode: 1, signal: null }, []), plan)(anySignal())).resolves.toBe(false)
  })

  it('is not ready when the command died from a signal', async () => {
    await expect(commandProbe(runnerAnswering({ exitCode: null, signal: 'SIGTERM' }, []), plan)(anySignal())).resolves.toBe(false)
  })

  it('propagates a spawn-level failure instead of reading it as unready', async () => {
    const runner = (): Promise<SubprocessOutcome> => Promise.reject(new Error('spawn EACCES'))
    await expect(commandProbe(runner, plan)(anySignal())).rejects.toThrow('spawn EACCES')
  })
})

describe('pollUntilReady', () => {
  it('settles ready on the first successful attempt', async () => {
    let calls = 0
    const outcome = await pollUntilReady(async () => {
      calls += 1
      return true
    }, { intervalMs: 5, timeoutMs: 1000 })
    expect(outcome).toEqual({ ready: true })
    expect(calls).toBe(1)
  })

  it('keeps polling at the configured interval until ready', async () => {
    let calls = 0
    const outcome = await pollUntilReady(async () => {
      calls += 1
      return calls >= 3
    }, { intervalMs: 2, timeoutMs: 2000 })
    expect(outcome).toEqual({ ready: true })
    expect(calls).toBe(3)
  })

  it('classifies a lapsed deadline as timeout', async () => {
    const outcome = await pollUntilReady(async () => false, { intervalMs: 2, timeoutMs: 30 })
    expect(outcome).toEqual({ ready: false, cause: 'timeout' })
  })

  it('classifies a lapsed deadline as timeout also when an idle external signal is present', async () => {
    const controller = new AbortController()
    const outcome = await pollUntilReady(async () => false, { intervalMs: 2, timeoutMs: 30, signal: controller.signal })
    expect(outcome).toEqual({ ready: false, cause: 'timeout' })
  })

  it('classifies an external abort during the delay as aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 10)
    const outcome = await pollUntilReady(async () => false, { intervalMs: 5000, timeoutMs: 60000, signal: controller.signal })
    expect(outcome).toEqual({ ready: false, cause: 'aborted' })
  })

  it('never probes on an already-aborted external signal', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const outcome = await pollUntilReady(async () => {
      calls += 1
      return true
    }, { intervalMs: 5, timeoutMs: 1000, signal: controller.signal })
    expect(outcome).toEqual({ ready: false, cause: 'aborted' })
    expect(calls).toBe(0)
  })

  it('classifies an abort landing while an attempt is in flight as aborted', async () => {
    let release: ((ready: boolean) => void) | undefined
    const controller = new AbortController()
    const settled = pollUntilReady(() => new Promise<boolean>((resolve) => { release = resolve }), {
      intervalMs: 5,
      timeoutMs: 60000,
      signal: controller.signal,
    })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    controller.abort()
    release!(false)
    await expect(settled).resolves.toEqual({ ready: false, cause: 'aborted' })
  })

  it('propagates a probe rejection', async () => {
    await expect(pollUntilReady(() => Promise.reject(new Error('probe defect')), { intervalMs: 5, timeoutMs: 1000 }))
      .rejects.toThrow('probe defect')
  })
})
