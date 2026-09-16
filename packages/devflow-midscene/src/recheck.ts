/** Final approval freshness: reuse the run's private login snapshot, without model or browser actions. */
import { join } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { request } from 'playwright'
import { publicationAvailable } from './publication.ts'
import { checkBuild } from './build-probe.ts'
import { workspaceIdentity, sha256, within } from './identity.ts'
import { verifyDeploymentRecord } from './deployment.ts'
import { parseSuite } from './suite.ts'
import type { RunManifest, RunOptions, StorageState } from './types.ts'

const snapshots = new WeakMap<RunManifest, StorageState | undefined>()
/** Retain credentials only for the lifetime of this in-memory run result. */
export function retainRecheckSnapshot(manifest: RunManifest, storageState: StorageState | undefined): void {
  snapshots.set(manifest, storageState)
}
/** Refuse stale or reconstructed evidence before committing a downstream transition. */
export async function recheckAcceptance(options: RunOptions, manifest: RunManifest): Promise<void> {
  if (!snapshots.has(manifest) || manifest.status !== 'passed' || !manifest.identity.targetInstanceId)
    throw new Error('Live acceptance identity unavailable')
  if (options.signal?.aborted) throw new Error('Acceptance cancelled')
  const deadline = Date.now() + options.timeoutMs
  const workspace = await realpath(options.workspace)
  if (within(join(workspace, '.devflow'), await realpath(options.suite)))
    throw new Error('Suite must be outside Devflow runtime state')
  const source = await readFile(options.suite)
  const suite = parseSuite(JSON.parse(source.toString('utf8')) as unknown, options.maxSteps)
  const current = await workspaceIdentity(workspace)
  if (workspace !== manifest.identity.workspace || current.commit !== manifest.identity.commit ||
    current.workspaceSha256 !== manifest.identity.workspaceSha256 || sha256(source) !== manifest.identity.suiteSha256 ||
    options.buildId !== manifest.identity.buildId || suite.buildProbe.expected !== options.buildId || !suite.buildProbe.instanceField)
    throw new Error('Acceptance inputs changed before commit')
  if (options.deploymentRecord) await verifyDeploymentRecord(options.deploymentRecord, workspace, current, options.buildId)
  const storageState = snapshots.get(manifest)
  const context = await request.newContext({ ...(storageState ? { storageState } : {}), timeout: Math.max(1, deadline - Date.now()) })
  try {
    if (await checkBuild(context, suite) !== manifest.identity.targetInstanceId)
      throw new Error('Build instance changed before commit')
    if (options.signal?.aborted) throw new Error('Acceptance cancelled')
    const paths = ['manifest.json', 'report.html', 'test-report.md', 'results.json',
      ...manifest.results.flatMap(result => [result.report, result.screenshot].filter((path): path is string => path !== undefined))]
    if (Date.now() >= deadline || !await publicationAvailable(join(options.output, manifest.runId), manifest.reports.baseUrl, paths,
      Math.max(1, deadline - Date.now()), options.signal)) throw new Error('Acceptance reports unavailable before commit')
  } finally {
    await context.dispose()
  }
}
