import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = import.meta.dirname
const rows = []
for (const stamp of (await readdir(join(root, 'runs'))).sort()) {
  const base = join(root, 'runs', stamp)
  const experiment = JSON.parse(await readFile(join(base, 'experiment.json'), 'utf8'))
  for (const mode of ['off', 'observe', 'assist']) {
    const metrics = await readFile(join(base, mode + '-metrics.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    if (metrics === undefined || metrics.outcome !== 'completed') continue
    const events = await readFile(join(base, mode+'-events.json'),'utf8').then(JSON.parse)
    const directJevToolCalls = events.filter(event => event.type === 'tool/result' && (event.tool === 'devflow_assess' || event.tool.startsWith('jev_'))).length
    const dir = join(base, mode, '.devflow/judgements/assistance')
    const records = await Promise.all((await readdir(dir).catch(() => [])).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(dir,name),'utf8'))))
    rows.push({ stamp, sampleClass: experiment.scenario === 'contract-failure' ? 'controlled-contract' : stamp === '2026-09-23T08-52-40-890Z' ? 'preparation' : 'natural', scenario: experiment.scenario ?? 'feature', mode, elapsedMs: metrics.elapsedMs, steps: metrics.steps, toolFailures: metrics.toolFailures, directJevToolCalls, acceptance: metrics.acceptance.passed, remoteJudgments: records.filter(record => record.model !== undefined).length, recordCount: records.length, delivered: records.filter(record => record.status === 'delivered').length, jevElapsedMs: metrics.assistanceElapsedMs, policyVersions: [...new Set(records.map(record => record.policyVersion))], sourceDigests: experiment.sourceDigests ?? null, provider: metrics.provider, model: metrics.model, jevModels: [...new Set(records.flatMap(record => record.model ? [record.model] : []))], inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, currencyCost: null, judgments: records.map(record=>({id:record.id,event:record.event,status:record.status,action:record.action,confidence:record.confidence,actionConfidence:record.actionConfidence??null,justifiedProbability:record.justifiedProbability??null,outcome:record.outcome,outcomeDetail:record.outcomeDetail??null})), interventions: records.filter(record=>record.action!=='continue').map(record=>({id:record.id,status:record.status,event:record.event,action:record.action,reason:record.reason,outcome:record.outcome,confidence:record.confidence})) })
  }
}
await writeFile(join(root, 'results.json'), JSON.stringify(rows,null,2))
console.log(rows.map(({stamp,scenario,mode,elapsedMs,steps,acceptance,remoteJudgments,delivered})=>({stamp,scenario,mode,elapsedMs,steps,acceptance,remoteJudgments,delivered})))
