import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const preparedRoot = process.env.DSH_SMOKE_ROOT ?? mkdtempSync(join(tmpdir(), 'dsh-scheduler-github-profile.'))
mkdirSync(preparedRoot, { recursive: true })
const root = mkdtempSync(join(preparedRoot, 'run-'))
const pnpm = process.env.DSH_SMOKE_PNPM
const runtime = join(preparedRoot, 'runtime')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const profile = join(root, 'home/profiles/acceptance')
const nodeDir = dirname(process.execPath)
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run with Node 24')
mkdirSync(join(root, 'bin'), { recursive: true })
// The launcher forwards package installation to pnpm on PATH.
if (pnpm) {
  const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`
  writeFileSync(join(root, 'bin/pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpm)} "$@"\n`, { mode: 0o755 })
}
const env = { ...process.env, PATH: `${join(root, 'bin')}:${nodeDir}:${process.env.PATH}`, DSH_HOME: join(root, 'home'), CI: 'true' }
function execute(command, args, log, cwd = repo) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timeout = setTimeout(() => child.kill('SIGKILL'), 600000)
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('exit', code => { clearTimeout(timeout); writeFileSync(join(root, log), output); code === 0 ? resolveRun(output) : reject(new Error(`${log}: exit ${code}\n${output.slice(-3000)}`)) })
  })
}
console.log(`Isolated evidence directory: ${root}`)
if (!existsSync(cli)) await execute(join(nodeDir, 'npm'), ['install', '--prefix', runtime, '@deepseek-ai/dsh@0.1.5-rc.2', '--no-audit', '--no-fund'], 'install.log')
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.1.5-rc.2')
await execute(process.execPath, [cli, '--version'], 'cli-version.log')
const packs = join(root, 'packs')
mkdirSync(packs, { recursive: true })
for (const pkg of ['scheduler', 'scheduler-local', 'github-sync', 'github-sync-local']) {
  assert.ok(existsSync(join(repo, 'packages', pkg, 'lib/index.js')), `Build ${pkg} before running acceptance`)
  await execute(pnpm ? process.execPath : 'pnpm', [...(pnpm ? [pnpm] : []), 'pack', '--pack-destination', packs], `pack-${pkg}.log`, join(repo, 'packages', pkg))
}
const tarballs = readdirSync(packs).filter(name => name.endsWith('.tgz')).map(name => join(packs, name))
mkdirSync(profile, { recursive: true })
// Unpublished dependency names must resolve to the packed artifacts too.
const overrides = Object.fromEntries(['scheduler', 'scheduler-local', 'github-sync', 'github-sync-local'].map(pkg => {
  const metadata = JSON.parse(readFileSync(join(repo, 'packages', pkg, 'package.json')))
  const tarball = tarballs.find(path => path.endsWith(`zhchxiao123-dsh-${pkg}-${metadata.version}.tgz`))
  assert.ok(tarball, `Missing packed ${metadata.name}`)
  return [metadata.name, `file:${tarball}`]
}))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'scheduler-github-acceptance', private: true, type: 'module', dsh: { profile: { bundles: [], patchReload: 'startup' } } }, null, 2) + '\n')
writeFileSync(join(profile, 'pnpm-workspace.yaml'), JSON.stringify({ overrides, minimumReleaseAge: 0 }, null, 2) + '\n')
await execute(process.execPath, [cli, 'plugin', '--profile', 'acceptance', 'add', ...tarballs], 'profile-install.log')
const manifestPath = join(profile, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath))
manifest.dsh = { ...manifest.dsh, profile: { bundles: [], patchReload: 'startup' } }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
copyFileSync(join(repo, 'examples/scheduler-github-sync/profile-probe.mjs'), join(profile, 'probe.mjs'))
const requests = []
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url })
  const path = new URL(request.url, 'http://fixture').pathname
  const base = { updated_at: '2026-09-14T00:00:00Z', html_url: 'https://github.com/fixture/project/issues/1', body: 'External untrusted issue text', state: 'open' }
  let data
  if (path === '/repos/fixture/project/issues') data = [{ ...base, id: 1, node_id: 'I_1', number: 1, title: 'Fixture issue' }, { ...base, id: 2, number: 2, title: 'Excluded PR', pull_request: {} }]
  else if (path === '/repos/fixture/project/issues/1/comments') data = [{ ...base, id: 3, node_id: 'IC_3', body: 'Fixture comment' }]
  else { response.writeHead(404); response.end('{}'); return }
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data))
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const patch = [{ insert: [
  ...['session', 'agent', 'llm', 'tools', 'system-prompt', 'session-projection', 'agent-loop', 'commands'].map(name => ({ id: `harness-${name}`, name: `@deepseek-ai/dsh-${name}` })),
  { id: 'scheduler-local', name: '@zhchxiao123/dsh-scheduler-local', config: { databasePath: join(root, 'scheduler.sqlite'), pollIntervalMs: 25 } },
  { id: 'github-sync-local', name: '@zhchxiao123/dsh-github-sync-local', config: { databasePath: join(root, 'github.sqlite'), apiUrl: `http://127.0.0.1:${address.port}`, pollIntervalMs: 25 } },
  { id: 'acceptance', name: './probe.mjs' },
] }]
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
try {
  await execute(process.execPath, [cli, '--profile', 'acceptance', '--dump-config'], 'profile-config.log')
  for (const phase of ['first', 'restart']) {
    const resultFile = join(root, `${phase}-result.json`)
    const child = spawn(process.execPath, [cli, '--profile', 'acceptance'], { cwd: root, env: { ...env, DSH_SMOKE_PHASE: phase, DSH_SMOKE_RESULT: resultFile }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let exitCode
    const closed = new Promise(resolveClose => {
      child.on('exit', code => { exitCode = code; resolveClose() })
      child.on('error', error => { output += error.stack; exitCode = 1; resolveClose() })
    })
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    try {
      const deadline = Date.now() + 30000
      while (!existsSync(resultFile) && exitCode === undefined && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50))
      assert.ok(existsSync(resultFile), `${phase} did not produce a result; see ${phase}-boot.log`)
      const result = JSON.parse(readFileSync(resultFile))
      assert.equal(result.status, 'passed', result.error)
      const { commandResults, ...summary } = result
      console.log(JSON.stringify({ ...summary, ...(commandResults ? { commandsPassed: commandResults.length } : {}) }))
    } finally {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      await closed
      clearTimeout(timeout)
      writeFileSync(join(root, `${phase}-boot.log`), output)
      writeFileSync(join(root, `${phase}-exit.json`), JSON.stringify({ exitCode }) + '\n')
      assert.equal(exitCode, 0, `${phase} CLI did not dispose cleanly`)
    }
  }
  assert.ok(requests.length > 0)
  assert.ok(requests.every(request => request.method === 'GET'))
  writeFileSync(join(root, 'requests.json'), JSON.stringify(requests, null, 2) + '\n')
  console.log('PASS: published CLI, packed providers, no-agent scheduled sync, persistence, independent consumers, restart and replay.')
} finally { await new Promise(resolveClose => server.close(resolveClose)) }
