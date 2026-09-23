import { mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repo = resolve(import.meta.dirname, '../..')
const work = import.meta.dirname
const runtime = join(work, 'runtime')
const requireRuntime = createRequire(join(runtime, 'package.json'))
const requireRepo = createRequire(join(repo, 'package.json'))
const load = async name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = join(work, 'runs', stamp)
await mkdir(output, { recursive: true })
const { build } = await import(pathToFileURL(requireRepo.resolve('tsdown')).href)
const pluginNames = ['devflow', 'devflow-filesystem', 'jev', 'jev-typesafe', 'devflow-jev']
for (const name of pluginNames) {
  const source = join(repo, 'packages', name)
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const target = join(runtime, 'node_modules', manifest.name)
  await mkdir(target, { recursive: true }); await copyFile(join(source, 'package.json'), join(target, 'package.json'))
  await build({ config: false, entry: [join(source, 'src/index.ts'), ...(name === 'jev' ? [join(source, 'src/runs-plugin.ts')] : [])],
    outDir: join(target, 'lib'), format: 'esm', platform: 'node', outExtensions: () => ({ js: '.js' }), dts: false,
    clean: true, external: [/^[^./]/, /^@[^/]+\//], logLevel: 'silent' })
}
const { Context } = await load('@deepseek-ai/cordis')
const { SessionId } = await load('@deepseek-ai/dsh-session')
const { createUserMessage, ToolCallId } = await load('@deepseek-ai/dsh-llm')
const { installModelSelection } = await load('@deepseek-ai/dsh-agent')
const userHome = join(homedir(), '.dsh')
const sourceDigests = {}
for (const name of ['assistance.ts','assistance-policy.ts','assistance-store.ts','workspace-evidence.ts']) sourceDigests[name] = createHash('sha256').update(await readFile(join(repo, 'packages/devflow-jev/src', name))).digest('hex')
const pluginBundleDigests = {}
for (const name of pluginNames) pluginBundleDigests[name] = createHash('sha256').update(await readFile(join(runtime, 'node_modules/@zhchxiao123/dsh-'+name+'/lib/index.js'))).digest('hex')
const runtimeLockDigest = createHash('sha256').update(await readFile(join(runtime, 'package-lock.json'))).digest('hex')
const scenario = process.argv[3] ?? 'feature'
const featurePrompt = '请给这个任务列表增加归档和恢复功能。归档后默认列表隐藏该任务，但 includeArchived: true 能看到；恢复后重新出现在默认列表。归档和恢复必须保存到磁盘，关闭进程后重新打开仍保持状态。保留任务原来的 id 和 title，不存在的 id 返回清晰错误，重复归档或恢复应保持幂等。请补充适当测试并运行验证。修改只限当前工作区，不安装依赖，不操作外部服务。'
const featureInitial = `import { readFile, writeFile } from 'node:fs/promises'\nimport { randomUUID } from 'node:crypto'\nexport class TaskStore {\n  constructor(path) { this.path = path }\n  async all() { try { return JSON.parse(await readFile(this.path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }\n  async create(title) { const tasks = await this.all(); const task = { id: randomUUID(), title }; tasks.push(task); await writeFile(this.path, JSON.stringify(tasks)); return task }\n  async list() { return this.all() }\n}\n`
const baseline = `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mkdtemp, rm } from 'node:fs/promises'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { TaskStore } from './store.mjs'\ntest('created tasks survive reopening', async () => { const dir = await mkdtemp(join(tmpdir(), 'tasks-')); try { const store = new TaskStore(join(dir, 'tasks.json')); const task = await store.create('Keep me'); assert.deepEqual(await new TaskStore(store.path).list(), [task]) } finally { await rm(dir, { recursive: true, force: true }) } })\n`
const prompt = scenario === 'contract-failure' ? '请修复当前任务列表项目的失败测试，保持归档/恢复接口与持久化约定；调查实际失败原因、修改实现并重新验证。修改只限当前工作区，不安装依赖，不操作外部服务。' : scenario === 'repair-review' ? '审查这次归档/恢复改动是否可以交付；发现实际问题就直接修复并验证，保持现有接口。修改只限当前工作区，不安装依赖，不操作外部服务。' : scenario === 'repair-draft' ? '请检查并完善我尚未提交的任务归档与恢复改动，确保可以交付。约定：默认列表隐藏已归档任务，includeArchived: true 能看到；恢复后重新出现；归档和恢复都必须在进程重启后仍保持；id 和 title 不变；不存在的 id 返回清晰错误；重复操作幂等。补充实际行为测试并运行，修改只限当前工作区，不安装依赖，不操作外部服务。' : (scenario.startsWith('repair') || scenario === 'contract-failure') ? '现有任务列表的归档和恢复在当前实例看起来正常，但进程重启后状态丢失。请修复这个问题，并检查归档与恢复的持久化是否都满足约定：默认列表隐藏已归档任务，includeArchived: true 返回全部；恢复后重新出现；id 和 title 不变；不存在的 id 返回清晰错误；重复调用幂等。补充能证明重启后状态保持的测试并运行。修改只限当前工作区，不安装依赖，不操作外部服务。' : featurePrompt
const initial = scenario.startsWith('repair') ? featureInitial.replace('  async list() { return this.all() }', `  async cached() { return this.items ??= await this.all() }
  async list({ includeArchived = false } = {}) { const tasks = await this.cached(); return includeArchived ? tasks : tasks.filter(task => !task.archived) }
  async archive(id) { const task = (await this.cached()).find(task => task.id === id); if (!task) throw new Error('Task not found: '+id); task.archived = true; return task }
  async restore(id) { const task = (await this.cached()).find(task => task.id === id); if (!task) throw new Error('Task not found: '+id); task.archived = false; return task }`) : featureInitial
const fixtureTests = baseline + (scenario === 'contract-failure' ? `test('archived state survives a fresh store', async () => { const dir = await mkdtemp(join(tmpdir(), 'archive-restart-')); try { const path = join(dir, 'tasks.json'); const store = new TaskStore(path); const task = await store.create('Keep me'); await store.archive(task.id); assert.equal((await new TaskStore(path).list()).length, 0) } finally { await rm(dir, {recursive:true,force:true}) } })\n` : '')
const acceptance = `import assert from 'node:assert/strict'\nimport { execFileSync } from 'node:child_process'\nimport { mkdtemp, rm } from 'node:fs/promises'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { pathToFileURL } from 'node:url'\nconst dir = await mkdtemp(join(tmpdir(), 'archive-acceptance-'))\nconst data = join(dir, 'tasks.json')\nconst moduleUrl = pathToFileURL(join(process.argv[2], 'store.mjs')).href\nconst invoke = code => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import {TaskStore} from '+JSON.stringify(moduleUrl)+'; const store = new TaskStore('+JSON.stringify(data)+');'+code], {encoding:'utf8'}))\ntry {\n const task=invoke('console.log(JSON.stringify(await store.create("Preserved title")))');\n invoke('await store.archive('+JSON.stringify(task.id)+'); console.log(JSON.stringify(true))');\n assert.deepEqual(invoke('console.log(JSON.stringify(await store.list()))'), []);\n const all=invoke('console.log(JSON.stringify(await store.list({includeArchived:true})))'); assert.equal(all.length,1); assert.equal(all[0].id,task.id); assert.equal(all[0].title,task.title);\n invoke('await store.archive('+JSON.stringify(task.id)+'); console.log(JSON.stringify(true))');\n invoke('await store.restore('+JSON.stringify(task.id)+'); console.log(JSON.stringify(true))');\n const restored=invoke('console.log(JSON.stringify(await store.list()))'); assert.equal(restored.length,1); assert.equal(restored[0].id,task.id); assert.equal(restored[0].title,task.title);\n invoke('await store.restore('+JSON.stringify(task.id)+'); console.log(JSON.stringify(true))');\n assert.equal(invoke('console.log(JSON.stringify((await store.list()).length))'),1);\n assert.equal(invoke('try { await store.archive("missing-id"); console.log("false") } catch(error) {console.log(JSON.stringify(Boolean(error.message)))}'),true);\n assert.equal(invoke('try { await store.restore("missing-id"); console.log("false") } catch(error) {console.log(JSON.stringify(Boolean(error.message)))}'),true);\n console.log('PASS: archive/restore, process restart, identity, missing-id, idempotence');\n} finally { await rm(dir,{recursive:true,force:true}) }\n`
await writeFile(join(output, 'acceptance.mjs'), acceptance)
await writeFile(join(output, 'experiment.json'), JSON.stringify({ scenario, prompt, sourceDigests, pluginBundleDigests, runtimeLockDigest, budgets: { agentTimeoutMs: 300000, agentMaxOutputTokensPerResponse: 12000, jevTimeoutMs: 15000, jevCallsPerTurn: 3, extraSteersPerTurn: 1 }, baselineDigest: createHash('sha256').update(initial + fixtureTests).digest('hex'), harness: '0.1.5-rc.2 npm', jev: 'jev-1.13.0', repeats: 1, qualityMetric: 'Independent process restart acceptance', limitations: ['One task and one run per mode cannot establish efficacy.', 'Actual provider token usage is recorded; currency cost is not inferred.'] }, null, 2))
const chosen = process.argv[2]
const modes = chosen ? [chosen] : ['off', 'observe', 'assist']
if (modes.some(mode => !['off','observe','assist'].includes(mode))) throw new Error('Expected off, observe, or assist')
const results = []
for (const mode of modes) {
  const fixture = join(output, mode); await mkdir(fixture)
  await writeFile(join(fixture, 'store.mjs'), ['repair-draft','repair-review'].includes(scenario) ? featureInitial : initial); await writeFile(join(fixture, 'store.test.mjs'), fixtureTests)
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }))
  for (const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','.'],['commit','-qm','identical baseline']]) await execute('git', args, { cwd: fixture })
  if (['repair-draft','repair-review'].includes(scenario)) await writeFile(join(fixture, 'store.mjs'), initial)
  const home = join(output, mode + '-home'); await mkdir(home); process.env.DSH_HOME = home
  const originalCwd = process.cwd(); process.chdir(fixture)
  const ctx = new Context()
  const mount = async (name, config = {}) => { const module = await load(name); await ctx.plugin(module.default ?? module, config).await() }
  const metrics = { mode, harness: '0.1.5-rc.2', provider: '', model: '', elapsedMs: 0, steps: 0, turns: 0, toolCalls: 0, toolFailures: 0, inputTokens: 0, outputTokens: 0, outcome: 'not-started', timedOut: false }
  const events = []; const controlledFailures = []; let finalText = ''; let agent
  const started = Date.now()
  try {
    await mount('@deepseek-ai/dsh-llm'); await mount('@deepseek-ai/dsh-session')
    await mount('@deepseek-ai/dsh-session-projection'); await mount('@deepseek-ai/dsh-agent')
    await mount('@deepseek-ai/dsh-system-prompt', { personaPrefix: 'You are a coding agent working in {{cwd}}. Complete the user task with actual code edits and tests. Stay in this workspace. No external services or dependency installs.' })
    await mount('@deepseek-ai/dsh-tools')
    await mount('@deepseek-ai/dsh-settings-file', { path: join(userHome, 'settings.yaml'), watch: false })
    await mount('@deepseek-ai/dsh-credentials-local', { path: join(userHome, '.credentials.yaml'), dshHome: userHome, watch: false })
    await mount('@deepseek-ai/dsh-agent-default-model', { provider: 'deepseek-official', model: 'deepseek-flash' })
    await mount('@deepseek-ai/dsh-llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 12000, streamIdleTimeoutMs: 60000 })
    await mount('@deepseek-ai/dsh-session-persistence-jsonl', { root: join(home, 'sessions') })
    await mount('@deepseek-ai/dsh-subprocess-local'); await mount('@deepseek-ai/dsh-bash-local', { cwd: fixture, timeoutMs: 30000 })
    await mount('@deepseek-ai/dsh-shell-env'); await mount('@deepseek-ai/dsh-fs-local', { cwd: fixture })
    await mount('@deepseek-ai/dsh-tool-bash', { enableRunInBackground: false }); await mount('@deepseek-ai/dsh-tool-fs')
    await mount('@deepseek-ai/dsh-jobs-local')
    await mount('@deepseek-ai/dsh-host-webserver', { host: '127.0.0.1', port: 0 })
    await mount('@zhchxiao123/dsh-devflow-filesystem', { root: join(fixture, '.devflow') })
    await mount('@zhchxiao123/dsh-jev-typesafe', { apiKeyRef: 'TYPESAFE_API_KEY', timeoutMs: 20000, maxRetries: 0 })
    await mount('@zhchxiao123/dsh-devflow-jev', { assistance: { mode, timeoutMs: 15000, maxCallsPerTurn: 3, maxSteersPerTurn: 1 } })
    await mount('@deepseek-ai/dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 })
    if (await ctx.jev.configurationStatus() !== 'configured') throw new Error('JEV_CREDENTIAL_UNAVAILABLE')
    if (!ctx.get('devflowAssistance')) throw new Error('ASSISTANCE_NOT_MOUNTED')
    const selection = ctx.agentDefaultModel.currentSelection(); metrics.provider = selection.provider; metrics.model = selection.model
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') metrics.turns++
      if (event.type === 'step/start') { metrics.steps++; console.log(JSON.stringify({ mode, step: metrics.steps, elapsedMs: Date.now() - started })) }
      if (event.type === 'assistant/message') { metrics.inputTokens += event.data.usage?.inputTokens ?? 0; metrics.outputTokens += event.data.usage?.outputTokens ?? 0; finalText = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') }
      if (event.type === 'turn/end') metrics.outcome = event.data.reason.kind
      if (['turn/start','step/start','turn/end'].includes(event.type)) events.push({ type: event.type, seq: event.seq })
    })
    ctx.on('tools/result', (exec, result) => { metrics.toolCalls++; const failed = result.isError || (typeof result.value?.exitCode === 'number' && result.value.exitCode !== 0); if (failed) metrics.toolFailures++; events.push({ type: 'tool/result', tool: exec.name, ok: !failed, ...(typeof result.value?.exitCode === 'number' ? {exitCode:result.value.exitCode}: {}) }) })

    if (scenario === 'contract-failure') {
      let checkpoints = 0
      ctx.on('agent/pre-step', async ({agent: currentAgent, signal}, next) => {
        checkpoints++
        if (checkpoints !== 2) return next()
        for (let index = 0; index < 2; index++) {
          const callId = ToolCallId('controlled-failure-' + randomUUID())
          const result = await ctx.tools.execute({callId, name:'bash', arguments:{command:'node --test store.test.mjs', description:'Controlled contract verification: execute the real failing persistence test'}, agent:currentAgent, signal})
          if (typeof result.value?.exitCode !== 'number' || result.value.exitCode === 0) throw new Error('CONTROLLED_FAILURE_NOT_REPRODUCED')
          controlledFailures.push({callId, exitCode:result.value.exitCode, output:result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').slice(0,6000)})
        }
        const decision = await next()
        return decision.kind !== 'enter' ? decision : {...decision,messages:[...decision.messages,createUserMessage({source:{kind:'plugin',plugin:'experiment-contract'},content:[{type:'text',text:'Controlled integration fixture: the following two executions used the real tool runtime and failed. Investigate this observed failure within the user request.\n'+JSON.stringify(controlledFailures)}]})]}
      })
    }
    const handle = await ctx.agents.create({ sessionId: SessionId('jev-experiment-' + randomUUID()), meta: { cwd: fixture }, agentOptions: { provider: selection.provider, model: selection.model, maxTokens: 12000 }, setup: child => { installModelSelection(child, { current: selection, assembled: undefined }) } })
    agent = handle.agent; await agent.whenIdle()
    const timer = setTimeout(() => { metrics.timedOut = true; agent.cancel() }, 300000)
    try { agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })); await agent.whenIdle() }
    finally { clearTimeout(timer) }
    await ctx.sessions.flush(agent.session)
  } catch (error) { metrics.outcome = 'runtime-error'; metrics.errorCategory = error instanceof Error ? error.name : 'unknown'; console.log(JSON.stringify({ mode, errorType: error instanceof Error ? error.name : 'unknown', errorCode: typeof error?.code === 'string' ? error.code : 'unspecified' })) }
  finally { metrics.elapsedMs = Date.now() - started; await ctx.fiber.dispose(); process.chdir(originalCwd) }
  await writeFile(join(output, mode + '-final.txt'), finalText)
  if (controlledFailures.length) await writeFile(join(output, mode+'-controlled-failures.json'), JSON.stringify(controlledFailures,null,2))
  let verification
  try { const run = await execute(process.execPath, [join(output, 'acceptance.mjs'), fixture], { timeout: 20000 }); verification = { passed: true, output: run.stdout.trim() } }
  catch (error) { verification = { passed: false, output: String(error.stderr ?? '').slice(0, 1500) } }
  const recordsDir = join(fixture, '.devflow/judgements/assistance')
  const names = await readdir(recordsDir).catch(() => [])
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(recordsDir,name),'utf8'))))
  metrics.assistanceRecordCount = records.length; metrics.assistanceCalls = records.filter(record => record.model !== undefined).length; metrics.assistanceStatuses = records.map(record => record.status)
  metrics.assistanceActions = records.map(record => record.action); metrics.assistanceElapsedMs = records.reduce((sum,record) => sum + record.elapsedMs,0)
  metrics.assistanceInputTokens = records.every(record => typeof record.inputTokens === 'number') ? records.reduce((sum,record) => sum + record.inputTokens,0) : null
  metrics.assistanceOutputTokens = records.every(record => typeof record.outputTokens === 'number') ? records.reduce((sum,record) => sum + record.outputTokens,0) : null
  metrics.currencyCost = null
  metrics.acceptance = verification
  await writeFile(join(output, mode + '-events.json'), JSON.stringify(events,null,2))
  await writeFile(join(output, mode + '-metrics.json'), JSON.stringify(metrics,null,2))
  results.push(metrics); await writeFile(join(output, 'summary.json'), JSON.stringify(results,null,2))
  console.log(JSON.stringify({ mode, outcome: metrics.outcome, elapsedMs: metrics.elapsedMs, acceptance: verification.passed, assistance: metrics.assistanceStatuses }))
}
console.log('Evidence: ' + output)
