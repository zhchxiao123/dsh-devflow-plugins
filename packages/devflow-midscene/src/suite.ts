/** Validates repository-authored suite JSON before browser or model work starts. */
import type { Step, Suite } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 16_384)
    throw new Error('Expected nonempty bounded string')
  return value
}
function step(value: unknown): Step {
  const item = record(value)
  switch (item.kind) {
    case 'goto':
      return { kind: 'goto', path: string(item.path) }
    case 'act':
    case 'assert':
      return { kind: item.kind, prompt: string(item.prompt) }
    case 'text':
      return { kind: 'text', selector: string(item.selector), expected: string(item.expected) }
    default:
      throw new Error('Unknown step kind')
  }
}
/** Decode the versioned file boundary and bound navigation and work before execution. */
export function parseSuite(value: unknown, maxSteps: number): Suite {
  const source = record(value)
  if (source.version !== 1 || !Array.isArray(source.cases)) throw new Error('Expected suite version 1 and cases array')
  const baseUrl = new URL(string(source.baseUrl))
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search)
    throw new Error('Expected HTTP target without credentials or query')
  const build = record(source.buildProbe)
  if (build.method !== undefined && build.method !== 'GET' && build.method !== 'POST') throw new Error('Invalid build probe method')
  if (build.format !== undefined && build.format !== 'text' && build.format !== 'json') throw new Error('Invalid build probe format')
  const field = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error('Invalid build probe field')
    return value.map(string)
  }
  if (build.format === 'json' && build.field === undefined) throw new Error('JSON build probe requires field')
  if (build.format !== 'json' && (build.field !== undefined || build.instanceField !== undefined)) throw new Error('Build probe fields require JSON')
  const suite: Suite = {
    version: 1,
    name: string(source.name),
    baseUrl: baseUrl.href,
    buildProbe: {
      path: string(build.path), expected: string(build.expected),
      ...(build.method === undefined ? {} : { method: build.method }),
      ...(build.format === undefined ? {} : { format: build.format }),
      ...(build.field === undefined ? {} : { field: field(build.field) }),
      ...(build.instanceField === undefined ? {} : { instanceField: field(build.instanceField) }),
    },
    cases: source.cases.map((value) => {
      const item = record(value)
      if (!Array.isArray(item.steps) || item.steps.length === 0) throw new Error('Cases require steps')
      return { id: string(item.id), steps: item.steps.map(step) }
    }),
  }
  if (suite.cases.length === 0 || new Set(suite.cases.map(c => c.id)).size !== suite.cases.length)
    throw new Error('Cases must be nonempty with unique IDs')
  const steps = suite.cases.flatMap(c => c.steps)
  if (steps.length > maxSteps || !steps.some(s => s.kind === 'assert'))
    throw new Error('Suite requires visual assertions within step limit')
  for (const path of [suite.buildProbe.path, ...steps.filter(s => s.kind === 'goto').map(s => s.path)]) {
    const target = new URL(path, baseUrl)
    if (target.origin !== baseUrl.origin || target.username || target.password)
      throw new Error('Navigation must stay on declared origin')
  }
  return suite
}
