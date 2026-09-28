// Score a real repository's changed files with Jev, one file at a time, and
// print the distribution behind every answer.
//
//   TYPESAFE_API_KEY=sk-… ./node_modules/.bin/tsx scripts/verify-jev.ts /path/to/repo [base-ref]
//
// This talks to the API directly. It deliberately shares nothing with the
// dsh-jev packages, so what it shows is Jev's judgement and not our wrapper's —
// which is what makes it usable as the calibration instrument for `jev_triage`
// rather than a second reading of the same wrapper.
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const [repo, base = 'HEAD'] = argv.filter(a => a !== '--dry-run')
const KEY = process.env.TYPESAFE_API_KEY
if (!repo || (!KEY && !DRY)) {
  console.error('usage: TYPESAFE_API_KEY=sk-… tsx scripts/verify-jev.ts <repo> [base-ref] [--dry-run]')
  console.error('  --dry-run prints the request instead of sending it — paste it into the Playground')
  process.exit(2)
}

const RUBRIC = [
  'Trivial: comments, formatting, renames, docs, or strings with no logic.',
  'Routine: isolated logic with obvious behavior; no new interfaces; failures stay local.',
  'Notable: new or changed interfaces, cross-module reach, subtle state or async ordering.',
  'Risky: authentication, authorization, secrets, payments, concurrency, migrations, or error-prone parsing.',
  'Critical: destructive or irreversible operations, or a security-critical path that could fail silently.',
]

// The decomposed alternative, asked alongside the single score so you can see
// which one you would rather threshold on.
const ATOMIC = {
  touches_authz: 'Does `diff` change authentication, authorization, or secret handling?',
  changes_contract: 'Does `diff` change a signature, schema, or wire format that other code depends on?',
  irreversible: 'Does `diff` add a destructive or irreversible operation — a delete, a migration, an overwrite?',
  concurrency: 'Does `diff` change ordering, locking, or async sequencing?',
  tests_only: 'Is every logic change in `diff` confined to test files?',
}

interface Question {
  readonly type: 'score' | 'noul'
  readonly instructions: Record<string, string>
  readonly criteria?: readonly string[]
}

interface Payload {
  readonly model: string
  readonly state: { readonly task: string; readonly repository: string }
  readonly questions: Readonly<Record<string, Question>>
}

// Request budget. Every file is asked about six times — one score plus the five
// atomic nouls — and each of those carries its own copy of that file's diff,
// because questions in one call all answer against the same state and a shared
// diff would let the files anchor each other. Six copies is why a request built
// from an ordinary-looking diff overruns: 97 changed files came to 356 KB.
//
// A request past either limit is refused whole, so the budget drops files
// rather than letting the call fail. Both numbers are second-hand — they come
// from jev-dsh-decision's README, not from a TypeSafe document or an observed
// refusal — so treat them as the conservative guess they are: if a real call is
// refused for size or count, these two constants are what to correct.
const MAX_FILES = 20
const MAX_QUESTIONS = 64
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_FILE_CHARS = 6000

const raw = execFileSync('git', [
  '-C', repo, 'diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', base,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const files: { path: string; lines: string[] }[] = []
for (const line of raw.split('\n')) {
  if (line.startsWith('diff --git ')) {
    const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line)
    files.push({ path: m?.[2] ?? line, lines: [line] })
  } else files.at(-1)?.lines.push(line)
}
if (files.length === 0) { console.log('no tracked changes'); process.exit(0) }

const STATE = { task: 'Git diff triage', repository: repo }
const build = (questions: Record<string, Question>): Payload => ({ model: 'jev-1.13.0', state: STATE, questions })

// A file contributes all six of its questions or none: a score whose atomic
// flags were budgeted away is exactly the comparison this script exists to make,
// reported as though both had been asked.
const questions: Record<string, Question> = {}
const included: { path: string; i: number }[] = []
const dropped: string[] = []

for (const [i, file] of files.entries()) {
  const reject = (reason: string): number => dropped.push(`${file.path} (${reason})`)
  if (included.length >= MAX_FILES) { reject(`past the ${MAX_FILES}-file cap`); continue }

  const diff = file.lines.join('\n').slice(0, MAX_FILE_CHARS)
  const added: Record<string, Question> = {
    [`risk${i}`]: {
      type: 'score',
      instructions: { task: 'How risky is this change to the file?', file: file.path, diff },
      criteria: RUBRIC,
    },
  }
  for (const [key, q] of Object.entries(ATOMIC)) {
    added[`${key}${i}`] = { type: 'noul', instructions: { question: q, file: file.path, diff } }
  }

  const candidate = { ...questions, ...added }
  if (Object.keys(candidate).length > MAX_QUESTIONS) { reject(`past the ${MAX_QUESTIONS}-question cap`); continue }
  if (Buffer.byteLength(JSON.stringify(build(candidate))) > MAX_REQUEST_BYTES) {
    // Not a break: a later, smaller diff can still fit in what is left.
    reject('past the request-size budget')
    continue
  }

  Object.assign(questions, added)
  included.push({ path: file.path, i })
}

if (included.length === 0) {
  console.error(`every one of ${files.length} file(s) overran the budget — the first diff alone exceeds ${MAX_REQUEST_BYTES} bytes`)
  process.exit(1)
}

const payload = build(questions)
const BYTES = Buffer.byteLength(JSON.stringify(payload))

/** What the budget refused, so a partial triage never reads as a whole one. */
function reportDropped(): void {
  if (dropped.length === 0) return
  console.error(`\n${dropped.length} file(s) not asked about:`)
  for (const line of dropped) console.error(`  ${line}`)
}

if (DRY) {
  console.log(JSON.stringify(payload, null, 2))
  console.error(`\n[dry run] ${included.length}/${files.length} file(s) asked about, ${Object.keys(questions).length} questions, ${BYTES} bytes`)
  reportDropped()
  process.exit(0)
}

// The usage check refuses a keyless live run and the dry run has exited above,
// so a missing key cannot reach here; the guard is what lets the type say so.
if (!KEY) process.exit(2)

const started = Date.now()
const response = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`)
  process.exit(1)
}
const body: unknown = await response.json()
const elapsed = Date.now() - started

// The response is a wire boundary: every field below is read through a check
// rather than asserted, so a shape change reports "(no answer)" instead of
// printing NaN as though it were a judgement.
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
function numberAt(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' ? value : undefined
}
function stringAt(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

const answers = record(record(body)?.['answers'])

for (const file of included) {
  const risk = record(answers?.[`risk${file.i}`])
  const score = numberAt(risk, 'score')
  const confidence = numberAt(risk, 'confidence')
  if (score === undefined || confidence === undefined) { console.log(`${file.path}\n  (no answer)\n`); continue }

  const dist = Object.entries(record(risk?.['probabilities']) ?? {})
    .map(([lvl, p]) => `${lvl}:${Number(p).toFixed(2)}`).join(' ')
  console.log(file.path)
  console.log(`  score ${score.toFixed(2)}  conf ${confidence.toFixed(2)}   [${dist}]`)

  const flags = Object.keys(ATOMIC)
    .map(k => [k, numberAt(record(answers?.[`${k}${file.i}`]), 'noul')] as const)
    .filter((entry): entry is readonly [string, number] => entry[1] !== undefined && entry[1] > 0.5)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
  console.log(`  ${flags.length ? flags.join('  ') : '(no atomic flag over 0.5)'}\n`)
}

console.log(`${included.length}/${files.length} file(s), ${Object.keys(questions).length} questions, ${BYTES} bytes, ${elapsed}ms`)
console.log(`input tokens: ${numberAt(record(record(body)?.['usage']), 'input_tokens') ?? '?'}  (output is free)`)
console.log(`model: ${stringAt(record(body), 'model') ?? '?'}`)
reportDropped()
