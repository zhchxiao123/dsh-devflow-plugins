/** Authenticated source/deployment probe shared by execution and final approval freshness checks. */
import { createHash } from 'node:crypto'
import type { APIRequestContext } from 'playwright'
import type { Suite } from './types.ts'
export async function checkBuild(request: Pick<APIRequestContext, 'get' | 'post'>, suite: Suite): Promise<string | undefined> {
  const spec = suite.buildProbe
  const url = new URL(spec.path, suite.baseUrl).href
  const response = spec.method === 'POST' ? await request.post(url, { data: {}, maxRedirects: 0 }) : await request.get(url, { maxRedirects: 0 })
  if (!response.ok() || new URL(response.url()).origin !== new URL(suite.baseUrl).origin) throw new Error('Build unavailable')
  const body = await response.text()
  const field = (value: unknown, path: string[]): unknown => path.reduce<unknown>((current, key) => current && typeof current === 'object' && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value)
  const value: unknown = spec.format === 'json' ? JSON.parse(body) : body.trim()
  if ((spec.format === 'json' ? field(value, spec.field ?? []) : value) !== spec.expected) throw new Error('Build mismatch')
  // Devflow build-info includes the client artifact; validate the served bytes independently.
  const envelope = value && typeof value === 'object' && 'value' in value ? value.value : undefined
  if (envelope && typeof envelope === 'object' && 'client' in envelope) {
    const client = envelope.client
    if (!client || typeof client !== 'object' || !('path' in client) || typeof client.path !== 'string' || !('sha256' in client) || typeof client.sha256 !== 'string') throw new Error('Invalid build client identity')
    const clientUrl = new URL(client.path, suite.baseUrl)
    if (clientUrl.origin !== new URL(suite.baseUrl).origin) throw new Error('Invalid build client origin')
    const asset = await request.get(clientUrl.href, { maxRedirects: 0 })
    if (!asset.ok() || createHash('sha256').update(await asset.body()).digest('hex') !== client.sha256) throw new Error('Served client build mismatch')
  }
  const instance = spec.instanceField ? field(value, spec.instanceField) : undefined
  if (spec.instanceField && (typeof instance !== 'string' || !instance)) throw new Error('Build instance unavailable')
  return typeof instance === 'string' ? instance : undefined
}
