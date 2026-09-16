/** Conversational login preparation uses paths, never secrets in tool arguments. */
import { realpath, rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectOutput } from './project-runtime.ts'
import { discoverProject } from './project.ts'
import { readSettings } from './project-settings.ts'
import { importLogin, loginPath, loginStatus } from './project-auth.ts'

export function registerAuthTools(ctx: Context): void {
  ctx.tools.register(defineTool({ name: 'midscene_auth',
    description: 'Inspect, import or clear this project’s private login snapshot for its selected origin and test role. Import only a user-authorized, owner-only Playwright storageState file outside the repository. Never pass passwords, cookies or tokens. Available means a usable snapshot exists, not that the server still accepts it; verify the logged-in role before test actions.',
    parameters: { action: { type: 'string', enum: ['status', 'import', 'clear'], required: true }, snapshotFile: { type: 'string', description: 'Private snapshot file path, required only for import.' }, targetUrl: { type: 'string', description: 'Verified application URL if discovery cannot select it.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      if (!exec.agent?.session.header.cwd) throw new Error('Midscene requires an owning workspace session')
      exec.signal.throwIfAborted()
      const workspace = await realpath(exec.agent.session.header.cwd)
      const settings = await readSettings(workspace)
      const discovery = await discoverProject(workspace, settings, args.targetUrl ? { targetUrl: args.targetUrl } : {})
      if (!discovery.selected) throw new Error('MIDSCENE_TARGET_REQUIRED: select the intended application first')
      const targetUrl = discovery.selected.url
      const path = loginPath(await projectOutput(workspace), targetUrl, settings.authentication?.role ?? '')
      if (args.action === 'import') {
        if (!args.snapshotFile) throw new Error('MIDSCENE_LOGIN_FILE_REQUIRED: provide an authorized private snapshot path')
        await importLogin(args.snapshotFile, path, workspace, targetUrl)
      } else if (args.action === 'clear') await rm(path, { force: true })
      return { text: JSON.stringify({ required: settings.authentication?.required ?? false,
        role: settings.authentication?.role ?? null, status: await loginStatus(path, workspace, targetUrl),
        note: 'Before protected actions, assert the expected logged-in page and role. Missing or expired login requires user cooperation; do not classify it as a product regression.' }) }
    },
  }))
}
