import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { terminateOwnedTree } from '../src/process-tree.ts'

it('stops stubborn detached descendants before terminating their parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'midscene-process-tree-'))
  const marker = join(dir, 'heartbeat')
  const childScript = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 20)`
  const parentScript = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(parent, 'close')
  let childPid: number | undefined
  try {
    const chunks: unknown = await once(parent.stdout, 'data')
    const chunk: unknown = Array.isArray(chunks) ? chunks[0] : undefined
    if (!Buffer.isBuffer(chunk) || !parent.pid) throw new Error('Fixture did not start')
    childPid = Number(chunk.toString('utf8').trim())
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        await readFile(marker, 'utf8').then(
          () => true,
          () => false,
        )
      )
        break
      await delay(20)
    }
    await terminateOwnedTree(parent.pid, childPid)
    await closed
    const stopped = await readFile(marker, 'utf8')
    await delay(100)
    expect(await readFile(marker, 'utf8')).toBe(stopped)
  } finally {
    if (parent.pid && parent.exitCode === null && parent.signalCode === null)
      await terminateOwnedTree(parent.pid, childPid)
    await rm(dir, { recursive: true, force: true })
  }
})
