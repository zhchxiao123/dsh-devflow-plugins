#!/usr/bin/env node
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DevflowStore } from './store.mjs'

export async function main(argv) {
  const [flag, root, action, id, revision, ...reason] = argv
  if (flag !== '--project' || !root || !action) {
    throw new Error('usage: node devflow-cli.mjs --project /absolute/project archived | archive <id> <revision> [reason] | restore <id> <revision> [reason] | abandon <id> <revision> <reason>')
  }
  const store = new DevflowStore(join(await realpath(root), '.devflow'))
  if (action === 'archived') return store.archived()
  const request = { id, expectedRevision: Number(revision), reason: reason.join(' ') }
  if (action === 'archive') return store.archive(request)
  if (action === 'restore') return store.restore(request)
  if (action === 'abandon') return store.abandon(request)
  throw new Error(`unknown action: ${action}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
