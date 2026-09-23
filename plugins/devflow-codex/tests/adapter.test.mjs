import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DevflowStore } from '../store.mjs'
import { startBoard } from '../board-server.mjs'
import { dispatch } from '../server.mjs'
import { loadPolicy } from '../gates.mjs'
import { isLegalTransition } from '../runtime/stages.ts'
import { runAgentReview } from '../agent-review.mjs'
import { main as cli } from '../devflow-cli.mjs'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const roots = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function newStore() {
  const project = await mkdtemp(join(tmpdir(), 'codex-devflow-'))
  const root = join(project, '.devflow')
  await mkdir(root)
  roots.push(project)
  return { root, store: new DevflowStore(root) }
}

test('reads an existing Harness journal and preserves its unrelated card frontmatter', async () => {
  const { root, store } = await newStore()
  const dir = join(root, 'tasks', '0001-existing')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'journal.jsonl'), JSON.stringify({ rev: 1, at: '2026-01-01T00:00:00Z', type: 'created', by: { kind: 'human' } }) + '\n')
  await writeFile(join(dir, 'card.md'), '---\ntitle: Existing\nlinks: [gh#1]\nstage: draft\nstageRevision: 1\n---\n\n## Requirement\nKeep this.\n')
  assert.deepEqual((await store.list()).map(card => card.id), ['0001-existing'])
  const artifact = await store.attach({ id: '0001-existing', expectedRevision: 1, kind: 'prd', content: '## PRD\nReady.' })
  assert.equal(artifact.stageRevision, 2)
  assert.match(await readFile(join(dir, 'card.md'), 'utf8'), /links: \[gh#1\]/)
  assert.equal((await store.readArtifact({ id: artifact.id, kind: 'prd' })).content, '## PRD\nReady.')
  await assert.rejects(() => store.attach({ id: artifact.id, expectedRevision: 1, kind: 'prd', content: 'stale' }), /revision-mismatch/)
  assert.equal((await readFile(join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 2)
})

test('bundled policy fails closed, while a project override checks artifacts and records verdicts', async () => {
  const { root, store } = await newStore()
  const card = await store.create({ title: 'Review service', body: 'Acceptance criteria' })
  assert.deepEqual((await loadPolicy(join(root, '..'))).edges['draft->designing'].artifacts, ['requirements-document'])
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /missing artifact requirements-document/)
  assert.equal((await readFile(join(root, 'tasks', card.id, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 1)
  await mkdir(join(root, '..', '.codex'), { recursive: true })
  await writeFile(join(root, '..', '.codex', 'devflow-policy.json'), '{broken')
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /invalid JSON/)
  await writeFile(join(root, '..', '.codex', 'devflow-policy.json'), JSON.stringify({ version: 1,
    kinds: { prd: { sections: ['Requirement'], nonEmptySections: ['Requirement'] } },
    edges: { 'draft->designing': { artifacts: ['prd'], commands: ["node -e 'process.exit(0)'"] } } }))
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /missing artifact prd/)
  const attached = await store.attach({ id: card.id, expectedRevision: 1, kind: 'prd', content: '## Requirement\nDone' })
  const moved = await store.transition({ id: card.id, to: 'designing', expectedRevision: attached.stageRevision })
  assert.equal(moved.stage, 'designing')
  const entries = (await readFile(join(root, 'tasks', card.id, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(entries.at(-1).gate.checks.length, 2)
})

test('failing command and unsupported approval leave the transition uncommitted', async () => {
  const { root, store } = await newStore()
  const card = await store.create({ title: 'Gate failure', body: 'Criteria' })
  const dir = join(root, '..', '.codex')
  await mkdir(dir)
  const policyPath = join(dir, 'devflow-policy.json')
  await writeFile(policyPath, JSON.stringify({ version: 1, edges: { 'draft->designing': { commands: ["node -e 'process.exit(2)'"] } } }))
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /command failed/)
  await writeFile(policyPath, JSON.stringify({ version: 1, edges: { 'draft->designing': { approval: true } } }))
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /interactive human approval provider/)
  assert.equal((await store.read(card.id)).stageRevision, 1)
})

test('parent completion gate rejects an unfinished child', async () => {
  const { root, store } = await newStore()
  const parent = await store.create({ title: 'Parent', body: 'Criteria', serviceClass: 'emergency' })
  const child = await store.create({ title: 'Child', body: 'Criteria', parent: parent.id })
  const dir = join(root, '..', '.codex')
  await mkdir(dir)
  await writeFile(join(dir, 'devflow-policy.json'), JSON.stringify({ version: 1, edges: {
    'draft->developing': {}, 'developing->done': {},
  } }))
  const developing = await store.transition({ id: parent.id, to: 'developing', expectedRevision: 1 })
  await assert.rejects(() => store.transition({ id: parent.id, to: 'done', expectedRevision: developing.stageRevision }), /unfinished children/)
  assert.equal((await store.read(parent.id)).stage, 'developing')
  assert.equal((await store.read(child.id)).stage, 'draft')
})

test('example policy covers every legal edge and includes ready', async () => {
  const { root } = await newStore()
  const project = join(root, '..')
  await mkdir(join(project, '.codex'))
  await writeFile(join(project, '.codex', 'devflow-policy.json'),
    await readFile(join(plugin, 'examples', 'devflow-policy.json')))
  const policy = await loadPolicy(project)
  const stages = ['draft', 'designing', 'ready', 'developing', 'reviewing', 'testing', 'done', 'blocked']
  for (const serviceClass of ['standard', 'express', 'emergency']) {
    for (const from of stages) for (const to of stages) {
      const card = { serviceClass, blockedFrom: from === 'blocked' && to !== 'done' ? to : undefined }
      if (isLegalTransition(from, to, card)) assert.ok(policy.edges[`${from}->${to}`], `${serviceClass}: ${from}->${to}`)
    }
  }
})

test('converted DSH policies preserve artifact rules and require independent review', async () => {
  const { root, store } = await newStore()
  const project = join(root, '..')
  const policyDir = join(project, '.codex')
  await mkdir(policyDir)
  const strict = JSON.parse(await readFile(join(plugin, 'examples', 'devflow-policy.from-dsh.strict.json')))
  const mechanical = JSON.parse(await readFile(join(plugin, 'examples', 'devflow-policy.from-dsh.mechanical-only.json')))
  for (const policy of [strict, mechanical]) {
    assert.deepEqual(policy.edges['designing->ready'].artifacts, ['requirements-document', 'design-document'])
    assert.deepEqual(policy.kinds['test-report'].sections, ['Scope', 'Results', 'Conclusion'])
  }
  assert.equal(strict.edges['draft->designing'].agentReview, true)
  assert.equal(mechanical.edges['draft->designing'].agentReview, undefined)
  const card = await store.create({ title: 'Converted policy', body: 'Acceptance criteria' })
  const path = join(policyDir, 'devflow-policy.json')
  await writeFile(path, JSON.stringify(strict))
  await loadPolicy(project)
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /missing artifact requirements-document/)
  await writeFile(path, JSON.stringify(mechanical))
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /missing artifact requirements-document/)
  assert.equal((await store.read(card.id)).stageRevision, 1)
})

test('bundled DSH checker vetoes before journal append and records independent allow', async () => {
  const { root } = await newStore()
  const calls = []
  let verdict = { verdict: 'veto', summary: 'Acceptance criteria contradict the goal' }
  const store = new DevflowStore(root, { reviewer: async request => { calls.push(request); return verdict } })
  const card = await store.create({ title: 'Independent review', body: 'Goal and criteria' })
  const artifact = await store.attach({ id: card.id, expectedRevision: 1, kind: 'requirements-document',
    content: `---\ncard: ${card.id}\nkind: requirements-document\ntitle: Requirement\n---\n## Problem\nA problem\n## Goals\nA goal\n## Acceptance Criteria\nA criterion\n` })
  const move = () => store.transition({ id: card.id, to: 'designing', expectedRevision: artifact.stageRevision })
  await assert.rejects(move, /Acceptance criteria contradict/)
  await assert.rejects(move, /Acceptance criteria contradict/)
  assert.equal(calls.length, 1)
  assert.equal((await store.read(card.id)).stageRevision, 2)
  assert.match(calls[0].prompt, /--- artifact requirements-document \(rev 2\) ---/)
  assert.equal(calls[0].timeoutMs, 600000)
  verdict = { verdict: 'allow', summary: 'Criteria are testable' }
  const updated = await store.attach({ id: card.id, expectedRevision: artifact.stageRevision, kind: 'requirements-document',
    content: `---\ncard: ${card.id}\nkind: requirements-document\ntitle: Updated\n---\n## Problem\nA problem\n## Goals\nA goal\n## Acceptance Criteria\nA revised criterion\n` })
  const moved = await store.transition({ id: card.id, to: 'designing', expectedRevision: updated.stageRevision })
  assert.equal(moved.stage, 'designing')
  assert.equal(calls.length, 2)
  const journal = (await readFile(join(root, 'tasks', card.id, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(journal.at(-1).gate.checks.at(-1).by.kind, 'agent')
  assert.match(await readFile(join(root, 'reports', 'agent-gate', `${card.id}-draft-designing-r3.json`), 'utf8'), /"allow"/)
})

test('independent reviewer CLI is read-only and invalid output fails closed', async () => {
  const { root } = await newStore()
  const binary = join(root, '..', 'fake-codex')
  await writeFile(binary, '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = --sandbox ] && [ "$3" = read-only ] || exit 9\ncat >/dev/null\nprintf \'{"verdict":"allow","summary":"Checked"}\\n\'\n')
  await chmod(binary, 0o755)
  const result = await runAgentReview({ project: join(root, '..'), prompt: 'Check card', timeoutMs: 1000, binary })
  assert.equal(result.verdict, 'allow')
  await writeFile(binary, '#!/bin/sh\ncat >/dev/null\nprintf invalid\\n\n')
  await assert.rejects(() => runAgentReview({ project: join(root, '..'), prompt: 'Check card', timeoutMs: 1000, binary }), /invalid JSON/)
})

test('human lifecycle archives, restores, and terminally abandons journaled cards', async () => {
  const { root, store } = await newStore()
  const project = join(root, '..')
  await mkdir(join(project, '.codex'))
  await writeFile(join(project, '.codex', 'devflow-policy.json'), JSON.stringify({ version: 1,
    edges: { 'draft->developing': {}, 'developing->done': {} } }))
  const done = await store.create({ title: 'Delivered', body: 'Criteria', serviceClass: 'emergency' })
  await store.transition({ id: done.id, to: 'developing', expectedRevision: 1 })
  await store.transition({ id: done.id, to: 'done', expectedRevision: 2 })
  const archived = await cli(['--project', project, 'archive', done.id, '3'])
  assert.equal(archived.archived, true)
  assert.deepEqual(await store.list(), [])
  assert.equal((await store.archived())[0].id, done.id)
  const restored = await cli(['--project', project, 'restore', done.id, '4'])
  assert.equal(restored.stage, 'done')
  assert.equal(restored.archived, undefined)
  assert.equal((await store.list()).length, 1)
  const dropped = await store.create({ title: 'Withdrawn', body: 'Criteria' })
  await assert.rejects(() => store.abandon({ id: dropped.id, expectedRevision: 1, reason: '' }), /reason/)
  const abandoned = await cli(['--project', project, 'abandon', dropped.id, '1', 'No', 'longer', 'needed'])
  assert.equal(abandoned.abandoned, true)
  await assert.rejects(() => store.restore({ id: dropped.id, expectedRevision: 2 }), /only archived/)
  assert.equal((await store.archived())[0].id, dropped.id)
  const listed = await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'devflow_archived', arguments: { projectRoot: project },
  } })
  assert.equal(JSON.parse(listed.result.content[0].text)[0].id, dropped.id)
})

test('bundled contract rejects null-valued frontmatter before review', async () => {
  const { root } = await newStore()
  let invoked = false
  const store = new DevflowStore(root, { reviewer: async () => { invoked = true; return { verdict: 'allow', summary: 'Pass' } } })
  const card = await store.create({ title: 'Structure', body: 'Criteria' })
  const attached = await store.attach({ id: card.id, expectedRevision: 1, kind: 'requirements-document',
    content: '---\ncard: null\nkind: requirements-document\ntitle: Document\n---\n## Problem\nProblem\n## Goals\nGoal\n## Acceptance Criteria\nCriterion' })
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: attached.stageRevision }), /missing frontmatter card/)
  assert.equal(invoked, false)
})

test('filing a finished parent cascades to its finished child', async () => {
  const { root, store } = await newStore()
  const project = join(root, '..')
  await mkdir(join(project, '.codex'))
  await writeFile(join(project, '.codex', 'devflow-policy.json'), JSON.stringify({ version: 1,
    edges: { 'draft->developing': {}, 'developing->done': {} } }))
  const parent = await store.create({ title: 'Parent', body: 'Criteria', serviceClass: 'emergency' })
  const child = await store.create({ title: 'Child', body: 'Criteria', serviceClass: 'emergency', parent: parent.id })
  for (const card of [parent, child]) await store.transition({ id: card.id, to: 'developing', expectedRevision: 1 })
  await store.transition({ id: child.id, to: 'done', expectedRevision: 2 })
  await store.transition({ id: parent.id, to: 'done', expectedRevision: 2 })
  await store.archive({ id: parent.id, expectedRevision: 3 })
  assert.equal((await store.read(child.id)).archived, true)
  assert.deepEqual(await store.list(), [])
})

test('approval gate records human signature only after an interactive acceptance', async () => {
  const { root } = await newStore()
  const project = join(root, '..')
  await mkdir(join(project, '.codex'))
  await writeFile(join(project, '.codex', 'devflow-policy.json'), JSON.stringify({ version: 1,
    edges: { 'draft->designing': { approval: true } } }))
  let accepted = false
  const store = new DevflowStore(root, { approver: async () => accepted })
  const card = await store.create({ title: 'Human review', body: 'Criteria' })
  await assert.rejects(() => store.transition({ id: card.id, to: 'designing', expectedRevision: 1 }), /approval declined/)
  accepted = true
  await store.transition({ id: card.id, to: 'designing', expectedRevision: 1 })
  const entry = JSON.parse((await readFile(join(root, 'tasks', card.id, 'journal.jsonl'), 'utf8')).trim().split('\n').at(-1))
  assert.deepEqual(entry.gate.approvedBy, { kind: 'human' })
})

test('MCP stdio form elicitation gates a transition and resumes the pending call', async () => {
  const { root, store } = await newStore()
  const project = join(root, '..')
  await mkdir(join(project, '.codex'))
  await writeFile(join(project, '.codex', 'devflow-policy.json'), JSON.stringify({ version: 1,
    edges: { 'draft->designing': { approval: true } } }))
  const card = await store.create({ title: 'Prompt human', body: 'Criteria' })
  const child = spawn(process.execPath, [join(plugin, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEVFLOW_TRUST_MCP_ELICITATION_HUMAN: '1' } })
  try {
    const seen = []
    let buffer = ''
    const final = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        let cut
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, cut))
          buffer = buffer.slice(cut + 1)
          seen.push(message)
          if (message.method === 'elicitation/create') child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { approved: true } },
          })}\n`)
          if (message.id === 2) resolve(message)
        }
      })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`server exited before approval: ${code}`)))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } },
    } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'devflow_transition', arguments: { projectRoot: project, id: card.id, to: 'designing', expectedRevision: 1 },
    } })}\n`)
    const completed = await final
    assert.equal(JSON.parse(completed.result.content[0].text).stage, 'designing')
    assert.equal(seen.filter(message => message.method === 'elicitation/create').length, 1)
  } finally { child.kill() }
})

test('two concurrent artifact writes cannot commit the same revision', async () => {
  const { root, store } = await newStore()
  const card = await store.create({ title: 'Race', body: 'Acceptance criteria' })
  const attempts = await Promise.allSettled([
    store.attach({ id: card.id, expectedRevision: 1, kind: 'first', content: 'First' }),
    store.attach({ id: card.id, expectedRevision: 1, kind: 'second', content: 'Second' }),
  ])
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected').length, 1)
  assert.equal((await readFile(join(root, 'tasks', card.id, 'journal.jsonl'), 'utf8')).trim().split('\n').length, 2)
})

test('rejects an artifact symlink that points outside the card', async () => {
  const { root, store } = await newStore()
  const card = await store.create({ title: 'Path check', body: 'Criteria' })
  const dir = join(root, 'tasks', card.id)
  await mkdir(join(dir, 'artifacts'))
  await writeFile(join(root, 'secret.txt'), 'not a card artifact')
  await symlink(join(root, 'secret.txt'), join(dir, 'artifacts', 'secret.txt'))
  await assert.rejects(() => store.attach({ id: card.id, expectedRevision: 1, path: 'artifacts/secret.txt' }), /symlink escapes/)
  assert.equal((await store.read(card.id)).stageRevision, 1)
})

test('vendored journal and stage definitions match the upstream engine', async () => {
  for (const filename of ['journal.ts', 'stages.ts', 'types.ts']) {
    const upstream = await readFile(join(plugin, '..', '..', 'packages', 'devflow', 'src', filename))
    const bundled = await readFile(join(plugin, 'runtime', filename))
    assert.deepEqual(bundled, upstream, `${filename} changed upstream; refresh the bundled runtime`)
  }
})

test('MCP stdio initialize, tools/list and calls work end to end', async () => {
  const { root } = await newStore()
  const child = spawn(process.execPath, [join(plugin, 'server.mjs')], { env: { ...process.env, DEVFLOW_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { lines.push(...chunk.trim().split('\n').filter(Boolean)) })
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'devflow_create', arguments: { title: 'Ship it', body: 'Criteria' } } })
  child.stdin.end()
  const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
  assert.equal(code, 0)
  const output = lines.map(line => JSON.parse(line))
  assert.equal(output.length, 3)
  assert.equal(output[0].result.serverInfo.name, 'devflow-codex')
  assert.ok(output[1].result.tools.some(tool => tool.name === 'devflow_create'))
  assert.equal(JSON.parse(output[2].result.content[0].text).stage, 'draft')
})

test('Kanban serves current cards and details without allowing writes', async () => {
  const { store } = await newStore()
  const card = await store.create({ title: 'Inspect the board', body: 'Acceptance criteria' })
  const server = await startBoard(store)
  try {
    const page = await fetch(server.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /开发进度/)
    const list = await (await fetch(new URL('/api/cards', server.url))).json()
    assert.equal(list.cards[0].id, card.id)
    assert.equal(list.stages.length, 7)
    const detail = await (await fetch(new URL(`/api/cards/${card.id}`, server.url))).json()
    assert.equal(detail.body, 'Acceptance criteria')
    const forbidden = await fetch(new URL('/api/cards', server.url), { method: 'POST' })
    assert.equal(forbidden.status, 405)
    const unknown = await fetch(new URL('/api/cards/../../other', server.url))
    assert.equal(unknown.status, 404)
  } finally { await server.close() }
})

test('devflow_board_open returns a reachable URL from the MCP process', async () => {
  const { root, store } = await newStore()
  await store.create({ title: 'Board link', body: 'Criteria' })
  const child = spawn(process.execPath, [join(plugin, 'server.mjs')], { env: { ...process.env, DEVFLOW_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const message = new Promise((resolve, reject) => {
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end !== -1) resolve(JSON.parse(buffer.slice(0, end)))
      })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`MCP exited before board URL: ${code}`)))
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'devflow_board_open', arguments: {} } }) + '\n')
    const result = await message
    const { url } = JSON.parse(result.result.content[0].text)
    const data = await (await fetch(new URL('/api/cards', url))).json()
    assert.equal(data.cards[0].title, 'Board link')
  } finally { child.kill() }
})

test('one MCP process keeps different projects in separate .devflow roots', async () => {
  const first = await mkdtemp(join(tmpdir(), 'devflow-project-one-'))
  const second = await mkdtemp(join(tmpdir(), 'devflow-project-two-'))
  roots.push(first, second)
  const call = (id, name, args) => dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  const missing = await call(1, 'devflow_create', { title: 'Unbound', body: 'Should not write' })
  assert.equal(missing.result.isError, true)
  assert.match(missing.result.content[0].text, /projectRoot is required/)
  const created = await call(2, 'devflow_create', { projectRoot: first, title: 'First project', body: 'Criteria' })
  assert.equal(created.result.isError, undefined)
  const other = await call(3, 'devflow_list', { projectRoot: second })
  assert.deepEqual(JSON.parse(other.result.content[0].text), [])
  const own = await call(4, 'devflow_list', { projectRoot: first })
  assert.equal(JSON.parse(own.result.content[0].text)[0].title, 'First project')
  await assert.rejects(() => readFile(join(second, '.devflow', 'tasks', '0001-first-project', 'journal.jsonl')), { code: 'ENOENT' })
})
