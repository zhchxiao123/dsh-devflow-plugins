#!/usr/bin/env node
/** Command entry for Harness shell/jobs and command gates. Every invocation executes fresh work. */
import { parseArgs } from 'node:util'
import { inspectRun, runAcceptance } from './runner.ts'
const usage = `dsh-midscene run --suite FILE --workspace GIT_ROOT --output EXTERNAL_DIR --card ID
  --build-id ID --model NAME --timeout-ms N --max-steps N --cleanup-timeout-ms N
  [--storage-state PRIVATE_FILE] [--deployment-record PRIVATE_FILE]
  [--browser-executable-path FILE] [--report-base-url HTTP_URL]
dsh-midscene inspect --run RUN_DIR [--timeout-ms N]
`
/** Execute one CLI invocation, retaining signal ownership until its work completes. */
export async function main(argv: string[]): Promise<number> {
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  try {
    if (argv[0] === '--worker' || argv[0] === '--terminate-tree') {
      const { workerMain } = await import('./worker.ts')
      await workerMain(argv)
      return 0
    }
    if (argv.includes('--help')) {
      process.stdout.write(usage)
      return 0
    }
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: Object.fromEntries(
        [
          'storage-state',
          'deployment-record',
          'suite',
          'workspace',
          'output',
          'card',
          'build-id',
          'model',
          'timeout-ms',
          'max-steps',
          'cleanup-timeout-ms',
          'browser-executable-path',
          'report-base-url',
          'run',
        ].map(name => [name, { type: 'string' as const }]),
      ),
    })
    const required = (name: string): string => {
      const value = values[name]
      if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`)
      return value
    }
    switch (positionals[0]) {
      case 'run': {
        const executablePath = values['browser-executable-path']
        const result = await runAcceptance({
          ...(typeof values['storage-state'] === 'string' ? { storageState: values['storage-state'] } : {}),
          ...(typeof values['deployment-record'] === 'string' ? { deploymentRecord: values['deployment-record'] } : {}),
          suite: required('suite'),
          workspace: required('workspace'),
          output: required('output'),
          card: required('card'),
          buildId: required('build-id'),
          model: required('model'),
          timeoutMs: Number(required('timeout-ms')),
          maxSteps: Number(required('max-steps')),
          cleanupTimeoutMs: Number(required('cleanup-timeout-ms')),
          ...(typeof executablePath === 'string' ? { executablePath } : {}),
          ...(typeof values['report-base-url'] === 'string' ? { reportBaseUrl: values['report-base-url'] } : {}),
          signal: controller.signal,
          onProgress: line => process.stdout.write(line + '\n'),
        })
        return result.status === 'passed' ? 0 : 1
      }
      case 'inspect': {
        const result = await inspectRun(
          required('run'),
          typeof values['timeout-ms'] === 'string' ? Number(values['timeout-ms']) : undefined,
        )
        process.stdout.write(JSON.stringify(result) + '\n')
        return result.status === 'passed' ? 0 : 1
      }
      default:
        throw new Error('Expected run or inspect command')
    }
  } catch (error) {
    const safe = new Set([
      'Invalid login snapshot',
      'Login snapshot target mismatch',
      'Private acceptance input must be outside workspace',
      'Private acceptance input requires owner-only access',
      'Deployment receipt does not match source and build',
      'Invalid build probe method',
      'Invalid build probe format',
      'Invalid build probe field',
      'JSON build probe requires field',
      'Build probe fields require JSON',
      'Expected object',
      'Expected nonempty bounded string',
      'Unknown step kind',
      'Expected suite version 1 and cases array',
      'Expected HTTP target without credentials or query',
      'Cases require steps',
      'Cases must be nonempty with unique IDs',
      'Suite requires visual assertions within step limit',
      'Navigation must stay on declared origin',
      'Limits must be positive integers',
      'Identity fields must be nonempty single lines',
      'Role-specific model conflicts with recorded model',
      'Build probe must match requested build identity',
      'Output must be outside the fingerprinted workspace',
      'Workspace must be a Git root',
      'Report base must be an HTTP URL without credentials',
      'Invalid manifest',
      'Invalid results',
      'Invalid counts',
      'Expected run or inspect command',
    ])
    const message =
      error instanceof Error && (safe.has(error.message) || /^Missing --[a-z-]+$/.test(error.message))
        ? error.message
        : 'Runtime or file access unavailable; check suite, Git root, output permissions and installed dependencies'
    process.stderr.write(JSON.stringify({ status: 'infrastructure-error', reason: message }) + '\n')
    return 1
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

process.exitCode = await main(process.argv.slice(2))
