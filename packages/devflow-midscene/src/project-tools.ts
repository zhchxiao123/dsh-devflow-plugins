/** Conversational project configuration and explicitly approved task acceptance bindings. */
import { realpath, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { DevflowCardId } from '@zhchxiao123/dsh-devflow'
import type { Config } from './config.ts'
import { discoverProject } from './project.ts'
import { parseProjectSettings, readProjectFile, readSettings, writeProjectFile, writeSettings, withProjectMutation } from './project-settings.ts'
import { projectOutput } from './project-runtime.ts'
import { parseSuite } from './suite.ts'
import { sha256, workspaceIdentity } from './identity.ts'
import { verifyDeploymentRecord } from './deployment.ts'
import { readPrivateJson } from './auth-state.ts'

const OUTPUT = { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] } as const
async function workspace(exec: ToolRunContext): Promise<string> {
  if (!exec.agent?.session.header.cwd) throw new Error('Midscene requires an owning workspace session')
  exec.signal.throwIfAborted()
  return realpath(exec.agent.session.header.cwd)
}
/** Registers alongside managed execution tools; no configuration is written at plugin load. */
export function registerProjectTools(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({ name: 'midscene_discover', description: 'Read current-project Midscene choices and static application candidates. Candidates require runtime verification; no processes or model requests are started.', parameters: {}, output: OUTPUT,
    async execute(_args, exec) {
      const root = await workspace(exec); const settings = await readSettings(root)
      return { text: JSON.stringify({ settings, discovery: await discoverProject(root, settings) }) }
    } }))
  ctx.tools.register(defineTool({ name: 'midscene_project', description: 'Remember explicit project choices as portable JSON, or migrate one current-workspace legacy profile. Does not approve acceptance suites. Omitted choices are removed; do not send secrets.',
    parameters: { settings: { type: 'string', description: 'JSON object with optional app, targetUrl, model {provider,model,family?}, limits {timeoutMs?,cleanupTimeoutMs?,maxSteps?}.' }, migrateProfile: { type: 'string', description: 'Current-workspace legacy profile name.' } }, output: OUTPUT,
    async execute(args, exec) {
      const root = await workspace(exec)
      return withProjectMutation(root, async () => {
        if ((args.settings === undefined) === (args.migrateProfile === undefined)) throw new Error('Choose settings or migrateProfile')
        let value: unknown
        if (args.settings !== undefined) value = JSON.parse(args.settings)
        else {
          const profile = Object.entries(config.profiles).find(([name]) => name === args.migrateProfile)?.[1]
          if (!profile || await realpath(profile.workspace) !== root) throw new Error('Legacy profile does not belong to current project')
          value = { targetUrl: profile.targetUrl,
            ...(profile.provider ? { model: { provider: profile.provider, model: profile.model, family: profile.family } } : {}) }
        }
        const settings = parseProjectSettings(value)
        if (settings.suites !== undefined) throw new Error('Use midscene_bind to approve suite bindings')
        const current = await readSettings(root)
        if (current.suites) settings.suites = current.suites
        await writeSettings(root, settings)
        return { text: JSON.stringify({ settings, note: 'Saved project choices. Service identity and model compatibility are verified during execution.' }) }
      })
    } }))
  ctx.tools.register(defineTool({ name: 'midscene_bind', description: 'Bind an existing task to a reviewed Midscene suite and an existing private deployment receipt. Requests one-shot user approval for a changed suite. Requires a JSON build probe with instanceField for completion freshness. Never fabricates deployment evidence.',
    parameters: { card: { type: 'string', required: true }, suite: { type: 'string', description: 'Existing project-relative suite path.' }, suiteJson: { type: 'string', description: 'Candidate suite JSON to store under .devflow after approval.' }, deploymentRecord: { type: 'string', description: 'Existing private deployment receipt outside project; omitted reuses this task’s prior receipt.' } }, output: OUTPUT,
    async execute(args, exec) {
      const root = await workspace(exec)
      return withProjectMutation(root, async () => {
        if (!/^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.card)) throw new Error('Invalid Devflow card id')
        const owner = exec.agent
        const devflow = ctx.get('devflow')
        if (!owner || ctx.get('agents')?.get(owner.id) !== owner || !devflow) throw new Error('Binding requires a live owning Agent and Devflow')
        if (!ctx.get('devflowValidators')) throw new Error('Install the Devflow gate engine before binding acceptance')
        const card = await devflow.read(DevflowCardId(args.card), join(root, '.devflow'))
        if ((args.suite === undefined) === (args.suiteJson === undefined)) throw new Error('Choose suite or suiteJson')
        const suitePath = args.suite ?? `.devflow/midscene/suites/${args.card}.json`
        const bytes = args.suiteJson ?? await readProjectFile(root, suitePath)
        if (bytes === undefined) throw new Error('Suite file not found')
        if (Buffer.byteLength(bytes) > 262144) throw new Error('Suite exceeds size limit')
        const settings = await readSettings(root)
        const suite = parseSuite(JSON.parse(bytes) as unknown, settings.limits?.maxSteps ?? 30)
        if (suite.buildProbe.format !== 'json' || !suite.buildProbe.instanceField)
          throw new Error('JSON build probe with instanceField required for completion freshness')
        const binding = { suite: suitePath, suiteSha256: sha256(bytes), buildId: suite.buildProbe.expected }
        parseProjectSettings({ suites: { [args.card]: binding } })
        const source = await workspaceIdentity(root)
        const output = await projectOutput(root)
        const destination = join(output, `deployment-${sha256(args.card)}.json`)
        const receiptPath = args.deploymentRecord ?? destination
        await verifyDeploymentRecord(receiptPath, root, source, binding.buildId)
        if (JSON.stringify(settings.suites?.[args.card]) !== JSON.stringify(binding)) {
          const approval = ctx.get('approval')
          if (!approval || await approval.request({ agent: owner, toolName: 'midscene_bind', signal: exec.signal, reason: `Approve acceptance suite for ${card.id}\nSHA256: ${binding.suiteSha256}\nBuild: ${binding.buildId}\n${bytes}` }) !== 'allowed-once') throw new Error('Acceptance suite approval required')
        }
        exec.signal.throwIfAborted()
        const currentCard = await devflow.read(DevflowCardId(args.card), join(root, '.devflow'))
        if (currentCard.stageRevision !== card.stageRevision || JSON.stringify(await readSettings(root)) !== JSON.stringify(settings)) throw new Error('Acceptance inputs changed during approval')
        if (args.suite !== undefined && await readProjectFile(root, suitePath) !== bytes) throw new Error('Acceptance suite changed during approval')
        const receipt = await readPrivateJson(receiptPath, root)
        const temporary = join(output, `.deployment-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
          await verifyDeploymentRecord(temporary, root, await workspaceIdentity(root), binding.buildId)
          await rename(temporary, destination)
        } finally { await rm(temporary, { force: true }) }
        const raw = await readProjectFile(root, '.devflow/validation.json')
        const policy: unknown = raw === undefined ? { version: 1, requirements: [] } : JSON.parse(raw)
        if (!policy || typeof policy !== 'object' || !('version' in policy) || policy.version !== 1 || !('requirements' in policy) || !Array.isArray(policy.requirements)) throw new Error('Invalid project validation policy')
        const requirement = { validators: ['midscene:project'], edges: ['testing->done', 'reviewing->done', 'developing->done'], cards: [args.card], timeoutMs: settings.limits?.timeoutMs ?? 180000 }
        const signature = (value: unknown): string | undefined => JSON.stringify(value, (key, part: unknown) => key === 'timeoutMs' ? undefined : part)
        const existing = policy.requirements.findIndex((item: unknown) => signature(item) === signature(requirement))
        if (existing < 0) policy.requirements.push(requirement)
        else policy.requirements[existing] = requirement
        await writeProjectFile(root, '.devflow/validation.json', `${JSON.stringify(policy, null, 2)}\n`)
        if (args.suiteJson !== undefined) await writeProjectFile(root, suitePath, bytes)
        await writeSettings(root, { ...settings, suites: { ...settings.suites, [args.card]: binding } })
        return { text: `Bound ${args.card} to approved suite ${binding.suiteSha256}. Completion requires fresh midscene:project validation.` }
      })
    } }))
}
