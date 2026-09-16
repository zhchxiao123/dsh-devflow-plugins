/** Session-scoped project choices resolve into isolated runtime inputs. */
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcceptanceProfile } from './config.ts'
import { sha256, within } from './identity.ts'
import { readSettings, readProjectFile } from './project-settings.ts'
import { parseSuite } from './suite.ts'
import { discoverProject } from './project.ts'
import { loginPath, loginStatus } from './project-auth.ts'
import { inferMidsceneFamily } from './model-bridge.ts'

/** Runtime artifacts never enter the repository's source fingerprint. */
export async function projectOutput(workspace: string): Promise<string> {
  const canonical = await realpath(workspace)
  const output = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'midscene', 'projects', sha256(canonical))
  if (within(canonical, output)) throw new Error('MIDSCENE_PRIVATE_STORAGE_REQUIRED: DSH_HOME must be outside the project')
  await mkdir(output, { recursive: true, mode: 0o700 })
  if (await realpath(output) !== output) throw new Error('MIDSCENE_PRIVATE_STORAGE_ALIASED')
  return output
}

/** Historical inspection resolves storage without requiring a model or running application. */
export async function projectHistoryProfile(owner: Agent): Promise<AcceptanceProfile> {
  if (!owner.session.header.cwd) throw new Error('Midscene requires an owning workspace session')
  const workspace = await realpath(owner.session.header.cwd)
  return { workspace, output: await projectOutput(workspace), modelSource: 'dsh', model: '', family: '', baseUrl: '', targetUrl: '', browserMode: 'puppeteer', timeoutMs: 180_000, cleanupTimeoutMs: 10_000, maxSteps: 30 }
}

/** Freeze the initiating request's model and the selected application for one job. */
export async function resolveProjectProfile(
  owner: Agent, overrides: { targetUrl?: string; app?: string; diagnostic?: boolean } = {}, card?: string,
): Promise<AcceptanceProfile> {
  const profile = await projectHistoryProfile(owner)
  const settings = await readSettings(profile.workspace)
  Object.assign(profile, settings.limits)
  const binding = card === undefined ? undefined : settings.suites?.[card]
  const suite = binding ? await readProjectFile(profile.workspace, binding.suite) : undefined
  const suiteUrl = suite === undefined ? undefined : parseSuite(JSON.parse(suite) as unknown, profile.maxSteps).baseUrl
  const targetUrl = overrides.targetUrl ?? settings.targetUrl ?? suiteUrl
  const discovered = await discoverProject(profile.workspace, settings, {
    ...(targetUrl === undefined ? {} : { targetUrl }),
    ...(overrides.app === undefined ? {} : { app: overrides.app }),
  })
  if (!discovered.selected) throw new Error(`MIDSCENE_TARGET_${discovered.status.toUpperCase()}: ${JSON.stringify(discovered)}`)
  const login = loginPath(profile.output, discovered.selected.url, settings.authentication?.role ?? '')
  const status = await loginStatus(login, profile.workspace, discovered.selected.url)
  if (overrides.diagnostic) profile.loginPreparation = { required: settings.authentication?.required ?? false, status }
  if (!overrides.diagnostic && settings.authentication?.required && status !== 'available')
    throw new Error('MIDSCENE_LOGIN_REQUIRED: ask for the test role and an authorized login snapshot; use midscene_auth to import it before protected actions')
  if (status === 'available') profile.storageState = login
  const selection = settings.model ?? owner.session.requestHeader()?.config
  if (!selection) throw new Error('MODEL_NOT_CONFIGURED: no initiating DSH model; select an existing DSH model')
  const family = ('family' in selection ? selection.family : undefined) ?? inferMidsceneFamily(selection.model)
  if (!family) throw new Error(`MODEL_FAMILY_UNKNOWN: select a verified Midscene family for ${selection.model}`)
  return { ...profile, projectSettingsHash: sha256(JSON.stringify(settings)), provider: selection.provider, model: selection.model, family,
    targetUrl: discovered.selected.url,
    ...(binding ? { suite: binding.suite, suiteSha256: binding.suiteSha256, buildId: binding.buildId,
      deploymentRecord: join(profile.output, `deployment-${sha256(String(card))}.json`) } : {}),
  }
}
