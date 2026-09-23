import { appendFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { decodeJournalEntry, foldArtifactRecords, foldJournal } from './runtime/journal.ts'
import { isCardLocation, isLegalTransition, isReworkEdge, isServiceClass } from './runtime/stages.ts'
import { evaluateTransition } from './gates.mjs'

const ID = /^\d{4,}-[a-z0-9][a-z0-9-]*$/
const KIND = /^[a-z0-9][a-z0-9-]*$/
const sleep = ms => new Promise(done => setTimeout(done, ms))

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value
}

function cardId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('invalid card id')
  return value
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('expectedRevision must be a positive integer')
  return value
}

function titleFromCard(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!frontmatter) throw new Error('card.md has no YAML frontmatter')
  const line = frontmatter[1].split(/\r?\n/).find(row => /^title:\s*/.test(row))
  if (!line) throw new Error('card.md has no title')
  const scalar = line.slice(6).trim()
  if (scalar.startsWith('"')) return JSON.parse(scalar)
  if (scalar.startsWith("'")) return scalar.slice(1, -1).replaceAll("''", "'")
  return scalar
}

function bodyFromCard(source) {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!match) throw new Error('card.md has no YAML frontmatter')
  return source.slice(match[0].length).trim()
}

function updatedProjection(source, stage, rev) {
  const match = source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/)
  if (!match) throw new Error('card.md has no YAML frontmatter')
  let fields = match[2]
  for (const [key, value] of [['stage', stage], ['stageRevision', rev]]) {
    const pattern = new RegExp(`^${key}:.*$`, 'm')
    fields = pattern.test(fields) ? fields.replace(pattern, `${key}: ${value}`) : `${fields}\n${key}: ${value}`
  }
  return match[1] + fields + match[3] + source.slice(match[0].length)
}

async function withLock(dir, run) {
  const path = join(dir, 'commit.lock')
  let handle
  for (let attempt = 0; attempt < 40; attempt++) {
    try { handle = await open(path, 'wx'); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      await sleep(25)
    }
  }
  if (!handle) throw new Error('write-contended: commit.lock remained held')
  try { return await run() }
  finally { await handle.close(); await rm(path, { force: true }) }
}

async function assertArtifactFile(dir, path) {
  const full = resolve(dir, path)
  const artifacts = resolve(dir, 'artifacts')
  if (!full.startsWith(`${artifacts}${sep}`)) throw new Error('artifact path must be inside card artifacts/')
  const realDir = await realpath(dir)
  const realArtifacts = await realpath(artifacts)
  if (realArtifacts !== join(realDir, 'artifacts')) throw new Error('card artifacts/ must not be a symlink')
  if (!(await realpath(full)).startsWith(`${realArtifacts}${sep}`)) throw new Error('artifact symlink escapes card artifacts/')
  if (!(await stat(full)).isFile()) throw new Error('artifact path must name a file')
  return full
}

export class DevflowStore {
  constructor(root, { reviewer, approver } = {}) { this.root = resolve(root); this.reviewer = reviewer; this.approver = approver }

  async locate(id) {
    id = cardId(id)
    const active = join(this.root, 'tasks', id)
    try { if ((await stat(active)).isDirectory()) return active }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    let months
    try { months = await readdir(join(this.root, 'archive')) }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`card not found: ${id}`); throw error }
    for (const month of months) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue
      const archived = join(this.root, 'archive', month, id)
      try { if ((await stat(archived)).isDirectory()) return archived }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    throw new Error(`card not found: ${id}`)
  }

  async entries(dir) {
    const path = join(dir, 'journal.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    return lines.map((line, index) => {
      try { return decodeJournalEntry(JSON.parse(line)) }
      catch (error) { throw new Error(`${path}:${index + 1}: ${error.message}`) }
    })
  }

  async read(id) {
    const dir = await this.locate(id)
    const entries = await this.entries(dir)
    const state = foldJournal(entries)
    const source = await readFile(join(dir, 'card.md'), 'utf8')
    return {
      id, title: titleFromCard(source), body: bodyFromCard(source),
      stage: state.stage, stageRevision: state.revision,
      serviceClass: state.serviceClass, parent: state.parent,
      blockedFrom: state.blockedFrom, archived: state.archived, abandoned: state.abandoned,
      createdAt: state.createdAt, updatedAt: state.updatedAt,
      artifacts: foldArtifactRecords(entries),
    }
  }

  async list() {
    let names
    try { names = await readdir(join(this.root, 'tasks')) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const cards = []
    for (const id of names.sort()) {
      if (!ID.test(id)) continue
      const card = await this.read(id)
      if (!card.archived && !card.abandoned) cards.push({
        id, title: card.title, stage: card.stage, stageRevision: card.stageRevision,
        serviceClass: card.serviceClass, parent: card.parent, blockedFrom: card.blockedFrom,
      })
    }
    return cards
  }

  async archived() {
    let months
    try { months = await readdir(join(this.root, 'archive')) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const cards = []
    for (const month of months.sort().reverse()) {
      if (!/^\d{4}-\d{2}$/.test(month)) continue
      for (const id of await readdir(join(this.root, 'archive', month))) {
        if (!ID.test(id)) continue
        const card = await this.read(id)
        cards.push({ id, title: card.title, stage: card.stage, stageRevision: card.stageRevision,
          archived: card.archived, abandoned: card.abandoned, month, parent: card.parent })
      }
    }
    return cards
  }

  async fileCard(dir, id, date) {
    const month = date.slice(0, 7)
    const destination = join(this.root, 'archive', month)
    await mkdir(destination, { recursive: true })
    await rename(dir, join(destination, id))
  }

  async archive({ id, expectedRevision, reason }) {
    id = cardId(id); revision(expectedRevision)
    const dir = join(this.root, 'tasks', id)
    const card = await withLock(dir, async () => {
      const current = await this.read(id)
      if (current.stageRevision !== expectedRevision) throw new Error(`revision-mismatch: card is at ${current.stageRevision}`)
      if (current.stage !== 'done' || current.archived || current.abandoned) throw new Error('only active done cards can be archived')
      if (current.parent) {
        const parent = await this.read(current.parent)
        if (parent.stage !== 'done' && !parent.abandoned) throw new Error(`parent-active: ${current.parent}`)
      }
      const children = (await this.list()).filter(child => child.parent === id && child.stage !== 'done')
      if (children.length) throw new Error(`unfinished children: ${children.map(child => child.id).join(', ')}`)
      const entry = { rev: expectedRevision + 1, at: new Date().toISOString(), type: 'archived',
        by: { kind: 'command', name: 'devflow' }, ...(reason ? { reason } : {}) }
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
      await this.project(dir, current.stage, entry.rev)
      return current
    })
    await this.fileCard(dir, id, card.updatedAt)
    for (const child of (await this.list()).filter(item => item.parent === id && item.stage === 'done')) {
      await this.archive({ id: child.id, expectedRevision: child.stageRevision, reason })
    }
    return this.read(id)
  }

  async abandon({ id, expectedRevision, reason }) {
    id = cardId(id); revision(expectedRevision); requiredString(reason, 'reason')
    const dir = join(this.root, 'tasks', id)
    await withLock(dir, async () => {
      const card = await this.read(id)
      if (card.stageRevision !== expectedRevision) throw new Error(`revision-mismatch: card is at ${card.stageRevision}`)
      if (card.stage === 'done' || card.abandoned || card.archived) throw new Error('cannot abandon a settled card')
      const children = (await this.list()).filter(child => child.parent === id && child.stage !== 'done')
      if (children.length) throw new Error(`unfinished children: ${children.map(child => child.id).join(', ')}`)
      const entry = { rev: expectedRevision + 1, at: new Date().toISOString(), type: 'abandoned',
        by: { kind: 'command', name: 'devflow' }, reason }
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
      await this.project(dir, card.stage, entry.rev)
    })
    await this.fileCard(dir, id, new Date().toISOString())
    for (const child of (await this.list()).filter(item => item.parent === id && item.stage === 'done')) {
      await this.archive({ id: child.id, expectedRevision: child.stageRevision })
    }
    return this.read(id)
  }

  async restore({ id, expectedRevision, reason }) {
    id = cardId(id); revision(expectedRevision)
    const dir = await this.locate(id)
    if (dir === join(this.root, 'tasks', id)) throw new Error('card is already active')
    await withLock(dir, async () => {
      const card = await this.read(id)
      if (card.stageRevision !== expectedRevision) throw new Error(`revision-mismatch: card is at ${card.stageRevision}`)
      if (card.abandoned || !card.archived) throw new Error('only archived cards can be restored')
      const entry = { rev: expectedRevision + 1, at: new Date().toISOString(), type: 'restored',
        by: { kind: 'command', name: 'devflow' }, ...(reason ? { reason } : {}) }
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
      await this.project(dir, card.stage, entry.rev)
    })
    await mkdir(join(this.root, 'tasks'), { recursive: true })
    await rename(dir, join(this.root, 'tasks', id))
    return this.read(id)
  }

  async create({ title, body, slug, parent, serviceClass = 'standard' }) {
    title = requiredString(title, 'title').trim()
    body = requiredString(body, 'body')
    if (!isServiceClass(serviceClass)) throw new Error('invalid serviceClass')
    slug ??= title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'
    if (!KIND.test(slug)) throw new Error('invalid slug')
    if (parent !== undefined) {
      const parentCard = await this.read(cardId(parent))
      if (parentCard.parent || parentCard.archived || parentCard.abandoned || parentCard.stage === 'done') {
        throw new Error('parent is a child or already settled')
      }
    }
    const tasks = join(this.root, 'tasks')
    await mkdir(tasks, { recursive: true })
    return withLock(tasks, async () => {
      const names = await readdir(tasks)
      let sequence = 1 + Math.max(0, ...names.map(name => Number(name.match(/^(\d+)-/)?.[1] ?? 0)))
      while (true) {
        const id = `${String(sequence++).padStart(4, '0')}-${slug}`
        const dir = join(tasks, id)
        try { await mkdir(dir) }
        catch (error) { if (error.code === 'EEXIST') continue; throw error }
        let committed = false
        try {
          const entry = { rev: 1, at: new Date().toISOString(), type: 'created', by: { kind: 'agent' },
            ...(parent ? { parent } : {}), ...(serviceClass !== 'standard' ? { serviceClass } : {}) }
          await writeFile(join(dir, 'card.md'), `---\ntitle: ${JSON.stringify(title)}\nstage: draft\nstageRevision: 1\n---\n\n${body.trim()}\n`, { flag: 'wx' })
          await writeFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'wx' })
          committed = true
          return await this.read(id)
        } catch (error) {
          if (!committed) await rm(dir, { recursive: true, force: true })
          throw error
        }
      }
    })
  }

  async attach({ id, expectedRevision, kind, content, path }) {
    id = cardId(id)
    revision(expectedRevision)
    if ((path === undefined) === (kind === undefined || content === undefined)) {
      throw new Error('provide either path or kind and content')
    }
    const dir = join(this.root, 'tasks', id)
    return withLock(dir, async () => {
      const card = await this.read(id)
      if (card.stageRevision !== expectedRevision) throw new Error(`revision-mismatch: card is at ${card.stageRevision}`)
      if (card.archived || card.abandoned) throw new Error('card is settled')
      let artifactPath = path
      if (path !== undefined) {
        requiredString(path, 'path')
        await assertArtifactFile(dir, path)
      } else {
        if (typeof kind !== 'string' || !KIND.test(kind)) throw new Error('invalid artifact kind')
        requiredString(content, 'content')
        artifactPath = `artifacts/${expectedRevision + 1}-${kind}.md`
        await mkdir(join(dir, 'artifacts'), { recursive: true })
        await writeFile(join(dir, artifactPath), content, { flag: 'wx' })
      }
      const entry = { rev: expectedRevision + 1, at: new Date().toISOString(), type: 'artifact',
        stage: card.stage, path: artifactPath, by: { kind: 'agent' }, ...(kind ? { kind } : {}) }
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
      await this.project(dir, card.stage, entry.rev)
      return this.read(id)
    })
  }

  async transition({ id, to, expectedRevision, reason }) {
    id = cardId(id)
    revision(expectedRevision)
    if (!isCardLocation(to)) throw new Error('invalid stage')
    const dir = join(this.root, 'tasks', id)
    return withLock(dir, async () => {
      const card = await this.read(id)
      if (card.stageRevision !== expectedRevision) throw new Error(`revision-mismatch: card is at ${card.stageRevision}`)
      if (card.archived || card.abandoned) throw new Error('card is settled')
      if (!isLegalTransition(card.stage, to, card)) throw new Error('illegal-edge')
      if (isReworkEdge(card.stage, to) && !reason?.trim()) throw new Error('reason-required')
      const gate = await evaluateTransition({ store: this, card, to,
        ...(this.reviewer ? { reviewer: this.reviewer } : {}),
        ...(this.approver ? { approver: this.approver } : {}),
        readArtifact: async path => readFile(await assertArtifactFile(dir, path), 'utf8') })
      const entry = { rev: expectedRevision + 1, at: new Date().toISOString(), type: 'transition',
        from: card.stage, to, by: { kind: 'agent' }, ...(reason ? { reason } : {}),
        ...(gate.checks.length || gate.approvedBy ? { gate: {
          ...(gate.checks.length ? { checks: gate.checks } : {}),
          ...(gate.approvedBy ? { approvedBy: gate.approvedBy } : {}),
        } } : {}) }
      await appendFile(join(dir, 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
      await this.project(dir, to, entry.rev)
      return this.read(id)
    })
  }

  async project(dir, stage, rev) {
    try {
      const path = join(dir, 'card.md')
      const updated = updatedProjection(await readFile(path, 'utf8'), stage, rev)
      const temporary = join(dir, `card.${process.pid}.${rev}.tmp`)
      await writeFile(temporary, updated)
      await rename(temporary, path)
    } catch (error) {
      // The journal append already committed; a projection failure cannot roll it back.
      process.stderr.write(`Devflow projection warning: ${error.message}\n`)
    }
  }

  async readArtifact({ id, kind }) {
    id = cardId(id)
    if (typeof kind !== 'string' || !KIND.test(kind)) throw new Error('invalid artifact kind')
    const card = await this.read(id)
    const record = card.artifacts.findLast(item => item.kind === kind)
    if (!record) throw new Error('no-artifact')
    const dir = join(this.root, 'tasks', id)
    const full = await assertArtifactFile(dir, record.path)
    return { ...record, content: await readFile(full, 'utf8') }
  }
}
