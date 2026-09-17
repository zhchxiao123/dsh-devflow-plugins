/** SQLite transactions bind versions, changes, and fenced progress to one commit. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { validate } from './validate.ts'
import type { SyncRun } from '@zhchxiao123/dsh-github-sync'
export class Database {
  readonly sql: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.sql = new DatabaseSync(path)
    const version = this.sql.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1) {
      this.sql.close()
      throw new Error('Unsupported GitHub database schema')
    }
    this.sql
      .exec(`PRAGMA user_version=1; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS responses(run TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run,request));
      CREATE TABLE IF NOT EXISTS committed_pages(run TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run,hash));
      CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, subscription TEXT NOT NULL, trigger TEXT NOT NULL UNIQUE, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(subscription TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(subscription,id));
      CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, subscription TEXT NOT NULL, object TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumers(subscription TEXT NOT NULL, id TEXT NOT NULL, acknowledged INTEGER NOT NULL, delivered INTEGER NOT NULL, PRIMARY KEY(subscription,id));`)
  }
  transaction<T>(body: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try {
      const value = body()
      this.sql.exec('COMMIT')
      return value
    } catch (error) {
      this.sql.exec('ROLLBACK')
      throw error
    }
  }
  records<T>(query: string, ...params: (string | number)[]): T[] {
    return this.sql
      .prepare(query)
      .all(...params)
      .map((row) => {
        if (typeof row.data !== 'string')
          throw new Error('Invalid durable record')
        const parsed: unknown = JSON.parse(row.data)
        validate(parsed)
        return parsed as T
      })
  }
  saveRun(run: SyncRun): void {
    this.sql
      .prepare(
        'INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(
        run.id,
        run.subscriptionId,
        run.triggerId,
        run.status,
        JSON.stringify(run),
      )
  }
  fence(id: string, owner: string, generation: number): SyncRun {
    const run = this.records<SyncRun>('SELECT data FROM runs WHERE id=?', id)[0]
    if (
      !run ||
      run.owner !== owner ||
      run.fence !== generation ||
      run.leaseUntil <= Date.now() ||
      !['running', 'waiting'].includes(run.status)
    )
      throw new Error('Execution ownership expired')
    return run
  }
  bytes(): number {
    const row = this.sql
      .prepare(
        'SELECT SUM(length(CAST(data AS BLOB))) AS bytes FROM (SELECT data FROM subscriptions UNION ALL SELECT data FROM runs UNION ALL SELECT data FROM snapshots UNION ALL SELECT data FROM changes UNION ALL SELECT data FROM responses)',
      )
      .get() as { bytes: number | null }
    return Number(row.bytes)
  }
}
