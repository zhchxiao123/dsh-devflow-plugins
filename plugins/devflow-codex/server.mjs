import { createInterface } from 'node:readline'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpath, stat } from 'node:fs/promises'
import { DevflowStore } from './store.mjs'
import { startBoard } from './board-server.mjs'

const boardServers = new Map()
const approvalRequests = new Map()
let approvalSequence = 0
let clientCanElicit = false

function requestApproval({ card, edge, timeoutMs }) {
  if (process.env.DEVFLOW_TRUST_MCP_ELICITATION_HUMAN !== '1') {
    throw new Error('MCP elicitation cannot attest human identity; configure a user-reviewed client and DEVFLOW_TRUST_MCP_ELICITATION_HUMAN=1')
  }
  if (!clientCanElicit) throw new Error('MCP client did not advertise form elicitation')
  return new Promise((resolve, reject) => {
    const id = `devflow-human-${++approvalSequence}`
    const timer = setTimeout(() => { approvalRequests.delete(id); reject(new Error('approval timed out')) }, timeoutMs)
    approvalRequests.set(id, reply => {
      clearTimeout(timer)
      if (reply.error) return reject(new Error(reply.error.message || 'elicitation failed'))
      resolve(reply.result?.action === 'accept' && reply.result?.content?.approved === true)
    })
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      mode: 'form', message: `Approve Devflow card ${card.id} (${card.title}) moving on ${edge}?`,
      requestedSchema: { type: 'object', properties: {
        approved: { type: 'boolean', description: 'Explicitly approve this one transition' },
      }, required: ['approved'] },
    } })}\n`)
  })
}

async function projectStore(args) {
  const requested = args?.projectRoot
  if (requested === undefined && !process.env.DEVFLOW_ROOT) {
    throw new Error('projectRoot is required: pass the absolute path of the current project in every Devflow tool call')
  }
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !isAbsolute(requested)) throw new Error('projectRoot must be an absolute path')
    const project = await realpath(requested)
    if (!(await stat(project)).isDirectory()) throw new Error('projectRoot must be a directory')
    return { store: new DevflowStore(join(project, '.devflow'), { approver: requestApproval }), project }
  }
  if (!isAbsolute(process.env.DEVFLOW_ROOT)) throw new Error('DEVFLOW_ROOT must be an absolute path')
  const root = resolve(process.env.DEVFLOW_ROOT)
  return { store: new DevflowStore(root, { approver: requestApproval }), project: dirname(root) }
}
const arg = (type, description, extra = {}) => ({ type, description, ...extra })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const project = { projectRoot: arg('string', 'Absolute path of the current project workspace; required unless DEVFLOW_ROOT is explicitly configured') }

const definitions = [
  {
    name: 'devflow_board_open', description: 'Open the read-only Devflow Kanban board for the specified project. Return a local URL to open in the Codex in-app browser.',
    inputSchema: schema(project),
    run: async args => {
      const { store, project } = await projectStore(args)
      if (!boardServers.has(store.root)) boardServers.set(store.root, await startBoard(store, project))
      return { url: boardServers.get(store.root).url, projectRoot: project, note: 'Open this URL in the Codex browser pane. The board refreshes every 5 seconds and is read only.' }
    },
  },
  {
    name: 'devflow_list', description: 'List active cards in the specified project workspace.',
    inputSchema: schema(project),
    run: async args => (await projectStore(args)).store.list(),
  },
  {
    name: 'devflow_archived', description: 'List archived and abandoned cards in the specified project workspace.',
    inputSchema: schema(project),
    run: async args => (await projectStore(args)).store.archived(),
  },
  {
    name: 'devflow_show', description: 'Show a card, its revision, body, and registered artifacts.',
    inputSchema: schema({ ...project, id: arg('string', 'Card id') }, ['id']),
    run: async args => (await projectStore(args)).store.read(args.id),
  },
  {
    name: 'devflow_create', description: 'Create a draft card in this project. State is stored in .devflow.',
    inputSchema: schema({ ...project,
      title: arg('string', 'Requirement title'), body: arg('string', 'Requirement and acceptance criteria'),
      slug: arg('string', 'Optional ASCII slug'), parent: arg('string', 'Optional parent card id'),
      serviceClass: arg('string', 'Pipeline variant', { enum: ['standard', 'express', 'emergency'] }),
    }, ['title', 'body']),
    run: async args => (await projectStore(args)).store.create(args),
  },
  {
    name: 'devflow_attach_artifact', description: 'Register an artifact on the current card revision. Supply either path or kind and content.',
    inputSchema: schema({ ...project,
      id: arg('string', 'Card id'), expectedRevision: arg('integer', 'Latest observed revision'),
      path: arg('string', 'Existing file relative to card directory, under artifacts/'),
      kind: arg('string', 'Kind of store-written artifact'), content: arg('string', 'Full Markdown content'),
    }, ['id', 'expectedRevision']),
    run: async args => (await projectStore(args)).store.attach(args),
  },
  {
    name: 'devflow_read_artifact', description: 'Read the newest registered artifact of a kind.',
    inputSchema: schema({ ...project, id: arg('string', 'Card id'), kind: arg('string', 'Artifact kind') }, ['id', 'kind']),
    run: async args => (await projectStore(args)).store.readArtifact(args),
  },
  {
    name: 'devflow_transition', description: 'Move a card after the bundled artifact checks and independent Codex review permit the stage change.',
    inputSchema: schema({ ...project,
      id: arg('string', 'Card id'), to: arg('string', 'Target stage', { enum: ['draft', 'designing', 'ready', 'developing', 'reviewing', 'testing', 'done', 'blocked'] }),
      expectedRevision: arg('integer', 'Latest observed revision'), reason: arg('string', 'Reason, required for rework'),
    }, ['id', 'to', 'expectedRevision']),
    run: async args => (await projectStore(args)).store.transition(args),
  },
]

const tools = new Map(definitions.map(({ run, ...definition }) => [definition.name, { run, definition }]))
const response = (id, result) => ({ jsonrpc: '2.0', id, result })

export async function dispatch(request) {
  if (request.jsonrpc === '2.0' && request.id !== undefined && !('method' in request)) {
    const pending = approvalRequests.get(request.id)
    if (pending) { approvalRequests.delete(request.id); pending(request) }
    return null
  }
  if (request.jsonrpc !== '2.0' || !('method' in request)) {
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  }
  if (request.method === 'notifications/initialized') return null
  if (request.method === 'initialize') {
    const elicitation = request.params?.capabilities?.elicitation
    clientCanElicit = !!elicitation && (elicitation.form !== undefined || Object.keys(elicitation).length === 0)
    return response(request.id, {
    protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'devflow-codex', version: '0.1.5' },
  })
  }
  if (request.method === 'ping') return response(request.id, {})
  if (request.method === 'tools/list') return response(request.id, {
    tools: definitions.map(({ run, ...definition }) => definition),
  })
  if (request.method === 'tools/call') {
    const selected = tools.get(request.params?.name)
    if (!selected) return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unknown tool' } }
    try {
      const output = await selected.run(request.params?.arguments ?? {})
      return response(request.id, { content: [{ type: 'text', text: JSON.stringify(output) }] })
    } catch (error) {
      return response(request.id, { content: [{ type: 'text', text: error.message }], isError: true })
    }
  }
  if (request.id === undefined) return null
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    // Keep reading while a tool call awaits a client response to elicitation/create.
    try {
      void dispatch(JSON.parse(line)).then(result => {
        if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`)
      }).catch(error => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32603, message: error.message } })}\n`))
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32700, message: error.message } })}\n`)
    }
  }
}
