/**
 * Readiness probes and the poller that drives them. Every probe answers
 * "ready now?" for one attempt; the poller owns pacing, the overall deadline,
 * and cancellation, matching the subprocess seam's rule that the caller holds
 * every deadline.
 *
 * The http probe uses `node:http` directly instead of `fetch`: Node's raw
 * client never consults `HTTP_PROXY`-style environment (or any dispatcher),
 * so a container-wide proxy cannot hijack a loopback readiness request. The
 * manifest restricts readiness URLs to `http:` for the same reason the probe
 * can stay this small.
 */

import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { HttpProbeSpec, PollOptions, PollOutcome, ReadinessProbe, SpawnPlan, SpawnRunner, TcpProbeSpec } from './types.ts'

/**
 * Probe readiness by opening one TCP connection.
 * @param spec - host and port to connect to.
 * @returns a probe that answers `true` once a connection opens.
 */
export function tcpProbe(spec: TcpProbeSpec): ReadinessProbe {
  return signal => new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const socket = connect({ host: spec.host, port: spec.port })
    const settle = (ready: boolean): void => {
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(ready)
    }
    const onAbort = (): void => { settle(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => { settle(true) })
    socket.once('error', () => { settle(false) })
  })
}

/**
 * Probe readiness with one direct GET on the configured URL.
 * @param spec - the URL, and the exact status that counts as ready (2xx when omitted).
 * @returns a probe that answers `true` on a wanted status and `false` on any
 *   refusal, reset, or abort.
 */
export function httpProbe(spec: HttpProbeSpec): ReadinessProbe {
  return signal => new Promise((resolve) => {
    const attempt = httpRequest(spec.url, { method: 'GET', signal }, (response) => {
      response.resume()
      /* v8 ignore next -- node:http always sets statusCode on client responses. */
      const status = response.statusCode ?? 0
      resolve(spec.status === undefined ? status >= 200 && status < 300 : status === spec.status)
    })
    attempt.once('error', () => { resolve(false) })
    attempt.end()
  })
}

/**
 * Probe readiness by running one command to completion; exit 0 means ready.
 * @param runner - executes the fully-specified spawn (the engine backs it with `ctx.subprocess`).
 * @param plan - the spawn request minus the per-attempt signal this probe appends.
 * @returns a probe that answers `true` on exit code 0; a spawn-level failure
 *   rejects through, because it is a defect rather than an unready service.
 */
export function commandProbe(runner: SpawnRunner, plan: SpawnPlan): ReadinessProbe {
  return async (signal) => {
    const outcome = await runner({ ...plan, signal })
    return outcome.exitCode === 0
  }
}

/**
 * Drive one probe until it answers ready, the deadline lapses, or the
 * caller's signal aborts. The active signal is also handed to every attempt,
 * so an in-flight attempt stops with the poll.
 * @param probe - the readiness attempt to repeat.
 * @param options - pacing, deadline, and optional external cancellation.
 * @returns the settled outcome; an unready result names which deadline ended it.
 */
export async function pollUntilReady(probe: ReadinessProbe, options: PollOptions): Promise<PollOutcome> {
  const deadline = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
  while (!signal.aborted) {
    if (await probe(signal)) return { ready: true }
    await abortableDelay(options.intervalMs, signal)
  }
  return { ready: false, cause: options.signal?.aborted === true ? 'aborted' : 'timeout' }
}

/** Resolve after `ms`, or immediately once `signal` aborts — never rejects. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
