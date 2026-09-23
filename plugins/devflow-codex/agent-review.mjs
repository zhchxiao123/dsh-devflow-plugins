import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const schema = fileURLToPath(new URL('./agent-review-schema.json', import.meta.url))

// Run an independent, ephemeral checker. The producer's MCP process never
// supplies a verdict, and neither CLI failure nor malformed output can allow.
export function runAgentReview({ project, prompt, timeoutMs, binary = process.env.DEVFLOW_CODEX_BIN || 'codex' }) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--sandbox', 'read-only', '--ignore-user-config', '--ephemeral',
      '--skip-git-repo-check', '--output-schema', schema, '-']
    const child = spawn(binary, args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let exceeded = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (stdout.length > 65536) { exceeded = true; child.kill('SIGKILL') }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000) })
    child.stdin.on('error', () => {}) // A CLI that exits early can close stdin before the prompt is written.
    child.stdin.end(prompt)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`checker could not start: ${error.message}`)) })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error('checker timed out'))
      if (exceeded) return reject(new Error('checker output exceeded limit'))
      if (code !== 0) return reject(new Error(`checker exited ${code}: ${stderr}`))
      let verdict
      try { verdict = JSON.parse(stdout.trim()) }
      catch { return reject(new Error('checker returned invalid JSON')) }
      if (!verdict || !['allow', 'veto'].includes(verdict.verdict) ||
          typeof verdict.summary !== 'string' || !verdict.summary.trim()) {
        return reject(new Error('checker returned an invalid verdict'))
      }
      resolve(verdict)
    })
  })
}
