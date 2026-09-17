/// <reference types="node" />
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Database } from '../src/database.ts'
import { validate } from '../src/validate.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function path() {
  const root = await mkdtemp(join(tmpdir(), 'sync-corrupt-'))
  roots.push(root)
  return join(root, 'state.sqlite')
}
it('rejects unknown database schema versions rather than opening with a guessed layout', async () => {
  const file = await path()
  const sql = new DatabaseSync(file)
  sql.exec('PRAGMA user_version=99')
  sql.close()
  expect(() => new Database(file)).toThrow('Unsupported')
})
it('rejects corrupt records and stale execution identities before a transaction can publish', async () => {
  const db = new Database(await path())
  try {
    db.sql.prepare('INSERT INTO subscriptions VALUES(?,?)').run('bad', 'null')
    expect(() => db.records('SELECT data FROM subscriptions')).toThrow(
      'Invalid durable',
    )
    expect(() => db.fence('missing', 'owner', 1)).toThrow('expired')
    expect(() =>
      db.transaction(() => {
        db.sql.prepare('INSERT INTO settings VALUES(?,?)').run('rollback', 1)
        throw new Error('crash')
      }),
    ).toThrow('crash')
    expect(db.sql.prepare('SELECT * FROM settings').all()).toEqual([])
  } finally {
    db.sql.close()
  }
})
const run = {
  subscriptionSnapshot: {
    id: 's',
    projectId: 'test-project', repository: 'a/b',
    actor: 'test',
    issues: true,
    discussions: false,
    revision: 1,
    paused: false,
  },
  checkpointSequence: 0,
  pageBudget: 10,
  id: 'r',
  subscriptionId: 's',
  triggerId: 't',
  actor: 'test',
  owner: 'o',
  acceptedAt: 1,
  pages: 0,
  objects: 0,
  retries: 0,
  fence: 1,
  leaseUntil: 2,
  status: 'running',
  reconcile: false,
}
const snapshot = {
  id: 'i',
  subscriptionId: 's',
  kind: 'issue',
  url: 'https://example.com',
  updatedAt: '2026-01-01',
  title: 't',
  body: 'b',
  state: 'open',
  fingerprint: 'f',
  version: 1,
  fetchedAt: 1,
  deleted: false,
}
it.each([
  null,
  [],
  {},
  { ...run, actor: 1 },
  { ...run, completedAt: -1 },
  { ...run, error: 1 },
  { ...run, status: 'impossible' },
  { ...snapshot, version: 0 },
  { ...snapshot, parentId: 3 },
  { ...snapshot, deleted: 1 },
  { subscriptionId: 's', objectId: 'i', version: 1, type: 'bad', snapshot },
  {
    subscriptionId: 's',
    objectId: 'wrong',
    version: 1,
    type: 'created',
    snapshot,
  },
  {
    id: 's',
    projectId: 'test-project', repository: 'a/b',
    actor: 'test',
    revision: 0,
    paused: false,
    issues: true,
    discussions: false,
  },
])('rejects invalid durable union record %j', (value) => {
  expect(() => {
    validate(value)
  }).toThrow()
})
it('validates optional run diagnostics and both content and subscription clocks', () => {
  expect(() => {
    validate({ ...run, waitUntil: 3, completedAt: 4, error: 'failure' })
  }).not.toThrow()
  expect(() => {
    validate({ ...snapshot, parentId: 'p' })
  }).not.toThrow()
  expect(() => {
    validate({
      id: 's',
      projectId: 'test-project', repository: 'a/b',
      actor: 'test',
      revision: 1,
      paused: false,
      issues: true,
      discussions: false,
      lastSuccessAt: 1,
      lastReconcileAt: 2,
    })
  }).not.toThrow()
})
it('rejects non-text durable payloads and measures UTF-8 payload bytes', async () => {
  const db = new Database(await path())
  try {
    db.sql
      .prepare('INSERT INTO subscriptions VALUES(?,?)')
      .run('blob', new Uint8Array([1]))
    expect(() => db.records('SELECT data FROM subscriptions')).toThrow(
      'Invalid durable record',
    )
    db.sql.prepare('DELETE FROM subscriptions').run()
    db.sql
      .prepare('INSERT INTO subscriptions VALUES(?,?)')
      .run('unicode', '中文')
    expect(db.bytes()).toBe(6)
  } finally {
    db.sql.close()
  }
})
it('rejects malformed durable ownership while decoding pre-project records as unassigned', () => {
  const subscription = { ...run.subscriptionSnapshot }
  delete (subscription as Partial<typeof subscription>).projectId
  validate(subscription)
  expect(subscription).toMatchObject({ projectId: null })
  expect(() => { validate({ ...subscription, projectId: '' }) }).toThrow('Invalid durable projectId')
  expect(() => { validate({ ...subscription, projectId: 42 }) }).toThrow('Invalid durable projectId')
})
