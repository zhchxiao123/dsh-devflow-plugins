// Run jev_triage against a real repository, with the same composition a
// deployment would use: the local subprocess + bash executors, the tools
// registry, the TypeSafe provider, and this line's triage consumer.
//
//   TYPESAFE_API_KEY=… node examples/jev-triage/triage.mjs /path/to/repo [base-ref]
//
// The key is read from the environment here because a standalone script has no
// credential store to read from. A deployment composes a real credential
// provider instead and this file's `EnvCredentials` has no equivalent there —
// the plugin itself never touches `process.env`.
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
// Relative paths on purpose: these packages are not published yet and the
// workspace root does not link them, so a name import would only work after
// `pnpm add` in a deployment. `pnpm run build` must have run.
import TypeSafeJev from '../../packages/jev-typesafe/lib/index.js'
import * as Triage from '../../packages/jev-triage/lib/index.js'

const [repo, base] = process.argv.slice(2)
if (repo === undefined) {
  console.error('usage: node examples/jev-triage/triage.mjs <absolute-repo-path> [base-ref]')
  process.exit(2)
}

class EnvCredentials extends CredentialProvider {
  constructor(ctx) {
    super(ctx, 'credentials')
  }

  resolve(ref) {
    const value = process.env[ref]
    return Promise.resolve(value === undefined || value === '' ? undefined : { ref, value, source: 'env' })
  }

  describe() { return Promise.reject(new Error('unused')) }
  set() { return Promise.reject(new Error('unused')) }
  unset() { return Promise.reject(new Error('unused')) }
  readRecord() { return Promise.reject(new Error('unused')) }
  describeRecord() { return Promise.reject(new Error('unused')) }
  listRecords() { return Promise.reject(new Error('unused')) }
  modifyRecord() { return Promise.reject(new Error('unused')) }
  deleteRecord() { return Promise.reject(new Error('unused')) }
}

const ctx = new Context()
await ctx.plugin(SubprocessLocal)
await ctx.plugin(BashLocal)
await ctx.plugin(SystemPrompt)
await ctx.plugin(Tools)
await ctx.plugin(EnvCredentials)
await ctx.plugin(TypeSafeJev, { apiKeyRef: 'TYPESAFE_API_KEY' })
await ctx.plugin(Triage, {})

const result = await ctx.tools.execute({
  name: 'jev_triage',
  arguments: base === undefined ? { cwd: repo } : { cwd: repo, base },
  callId: 'example-triage',
  signal: AbortSignal.timeout(120_000),
})

for (const block of result.content) {
  if (block.type === 'text') console.log(block.text)
}
await ctx.fiber.dispose()
