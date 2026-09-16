/** Static repository discovery returns evidence, never a claim that a service is running. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseProjectSettings, projectRelativePath, projectTargetUrl, readProjectFile } from './project-settings.ts'
import type { ProjectSettings } from './project-settings.ts'

export interface DiscoveredTarget { url: string; app: string; evidence: string }
export interface ProjectDiscovery {
  workspace: string
  apps: { path: string; scripts: Record<string, string> }[]
  targets: DiscoveredTarget[]
  suites: { path: string; evidence: string }[]
  selected?: DiscoveredTarget
  status: 'ready' | 'ambiguous' | 'unavailable'
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected project JSON object')
  return value as Record<string, unknown>
}
function relative(app: string, file: string): string { return app === '.' ? file : `${app}/${file}` }
/** Discover conventional workspaces only; no dependency directories or arbitrary executable configs are loaded. */
export async function discoverProject(workspace: string, settings: ProjectSettings = {}, overrides: Pick<ProjectSettings, 'app' | 'targetUrl'> = {}): Promise<ProjectDiscovery> {
  const root = await realpath(workspace)
  const choice = parseProjectSettings({ ...settings, ...overrides })
  const apps = new Set<string>(['.'])
  if (choice.app) apps.add(projectRelativePath(choice.app))
  for (const directory of ['apps', 'packages']) {
    const directoryPath = join(root, directory)
    const stat = await lstat(directoryPath).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) continue
    if (stat.isSymbolicLink()) throw new Error('Midscene workspace discovery must not follow symbolic links')
    const entries = await readdir(directoryPath, { withFileTypes: true })
    if (entries.length > 256) throw new Error('Too many workspace candidates; select an application explicitly')
    for (const entry of entries) if (entry.isDirectory()) apps.add(`${directory}/${entry.name}`)
  }
  const result: ProjectDiscovery = { workspace: root, apps: [], targets: [], suites: [], status: 'unavailable' }
  const add = (raw: unknown, app: string, evidence: string): void => {
    const url = projectTargetUrl(raw)
    if (!result.targets.some(target => target.url === url && target.app === app)) result.targets.push({ url, app, evidence })
  }
  for (const app of apps) {
    if (choice.app !== undefined && choice.app !== app) continue
    const packagePath = relative(app, 'package.json')
    const manifest = await readProjectFile(root, packagePath)
    if (manifest !== undefined) {
      const source = record(JSON.parse(manifest))
      const scripts = source.scripts === undefined ? {} : record(source.scripts)
      const startScripts = Object.fromEntries(Object.entries(scripts).filter(([name, value]) => /^(dev|start|serve|preview)$/.test(name) && typeof value === 'string')) as Record<string, string>
      result.apps.push({ path: app, scripts: startScripts })
      for (const [name, command] of Object.entries(startScripts)) {
        // A literal port in a known web-server command is evidence; framework defaults are not.
        if (!/\b(?:vite|next|nuxt|astro|http-server)\b/.test(command)) continue
        const match = /(?:--port(?:=|\s+)|\s-p\s+)(\d{1,5})(?=\s|$)/.exec(command)
        if (match) add(`http://localhost:${match[1]}`, app, `${packagePath} scripts.${name} explicit port (requires runtime verification)`)
      }
    }
    for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
      const path = relative(app, file)
      const config = await readProjectFile(root, path)
      const port = config?.match(/server\s*:\s*\{\s*port\s*:\s*(\d{1,5})\s*[,}]/)
      if (port) add(`http://localhost:${port[1]}`, app, `${path} literal server.port (requires runtime verification)`)
    }
    for (const file of ['e2e/acceptance.json', '.devflow/midscene/suites/acceptance.json']) {
      const path = relative(app, file)
      const suite = await readProjectFile(root, path)
      if (suite === undefined) continue
      const source = record(JSON.parse(suite))
      if (source.version !== 1 || !Array.isArray(source.cases)) continue
      result.suites.push({ path, evidence: 'Existing Midscene suite; approval and build binding still required' })
      add(source.baseUrl, app, `${path} declared baseUrl (requires runtime verification)`)
    }
  }
  if (choice.targetUrl !== undefined) {
    const selected = { url: choice.targetUrl, app: choice.app ?? '.', evidence: 'Explicit project target (requires runtime verification)' }
    result.targets = [selected]
  }
  const [selected] = result.targets
  if (selected && result.targets.length === 1) { result.selected = selected; result.status = 'ready' }
  else if (result.targets.length > 1) result.status = 'ambiguous'
  return result
}
