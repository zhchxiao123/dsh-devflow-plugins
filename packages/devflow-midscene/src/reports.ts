/** Finalizes durable evidence before success is exposed. Markdown links survive copying into card artifacts. */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from './types.ts'

/** Atomically replace the durable run snapshot within its private output directory. */
export async function writeManifest(dir: string, manifest: RunManifest): Promise<void> {
  const data = JSON.stringify(manifest, null, 2) + '\n'
  await writeFile(join(dir, 'manifest.json.tmp'), data, { mode: 0o600 })
  await rename(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'))
}
/** Verify case files before writing summary, finite results, and the terminal manifest. */
export async function finalizeReports(dir: string, manifest: RunManifest): Promise<void> {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const links = manifest.results.flatMap(c => [c.report, c.screenshot].filter((p): p is string => p !== undefined))
  for (const path of links) if ((await readFile(join(dir, path))).length === 0) throw new Error('Empty report')
  const link = (path: string) => new URL(path, manifest.reports.baseUrl).href
  const summary = `---\ncard: ${JSON.stringify(manifest.card)}\nkind: test-report\ntitle: Midscene acceptance\n---\n\n# Midscene acceptance\n\n## Scope\n\nRecorded suite: ${manifest.identity.suiteSha256}; target build: ${manifest.identity.buildId}.\n\n## Coverage\n\nRun: ${manifest.runId}\n\nCard: ${manifest.card}\n\nCases: ${manifest.counts.completedCases}/${manifest.counts.cases}; assertions: ${manifest.counts.passedAssertions}/${manifest.counts.assertions}; steps: ${manifest.counts.completedSteps}/${manifest.counts.steps}.\n\n## Results\n\nStatus: **${manifest.status}**\n\nCleanup: ${manifest.cleanup}\n\nBuild: ${manifest.identity.buildId}; HTTP verified: ${manifest.identity.buildVerified}\n\nCommit: ${manifest.identity.commit}\n\nModel: ${manifest.identity.model}; SDK: ${manifest.identity.midscene}; Playwright: ${manifest.identity.playwright}\n\nStarted: ${manifest.startedAt}; ended: ${manifest.endedAt ?? 'unknown'}\n\nWorkspace SHA256: ${manifest.identity.workspaceSha256}\n\nSuite SHA256: ${manifest.identity.suiteSha256}\n\nModel usage: ${JSON.stringify(manifest.usage)}\n\n[HTML report](${link('report.html')})\n\n${links.map(p => `[${p}](${link(p)})`).join('\n\n')}\n\n## Conclusion\n\nThis run records **${manifest.status}**. Completing a card still requires a fresh configured gate; historical reports do not authorize a new transition.\n`
  await writeFile(join(dir, 'test-report.md'), summary, { mode: 0o600 })
  await writeFile(
    join(dir, 'report.html'),
    `<!doctype html><meta charset="utf-8"><title>Midscene ${escape(manifest.runId)}</title><h1>${escape(manifest.status)}</h1><pre>${escape(summary)}</pre>${links.map(p => `<p><a href="${escape(p)}">${escape(p)}</a></p>`).join('')}`,
    { mode: 0o600 },
  )
  await writeFile(join(dir, 'results.json'), JSON.stringify(manifest.results, null, 2) + '\n', { mode: 0o600 })
  await writeManifest(dir, manifest)
}
