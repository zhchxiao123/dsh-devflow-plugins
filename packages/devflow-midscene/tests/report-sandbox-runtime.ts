/** Exercise the actual published SDK UI under the report route's opaque-origin CSP. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from 'vitest'
// This module runs in Node; the narrow document surface is evaluated only inside Chromium.
declare const document: { cookie: string }
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; img-src 'self' data: blob:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"
export async function verifyReportSandbox(path: string): Promise<void> {
  const html = await readFile(path)
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/report') { response.setHeader('Content-Security-Policy', CSP); response.end(html) }
    else response.end('<!doctype html><html><body>Host application</body></html>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const browser = await chromium.launch({ headless: true })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
    const origin = `http://127.0.0.1:${address.port}`
    const context = await browser.newContext()
    const host = await context.newPage()
    await host.goto(origin)
    await host.evaluate(() => { localStorage.setItem('host-secret', 'private'); sessionStorage.setItem('host-session', 'private'); document.cookie = 'hostCookie=private; path=/' })
    const report = await context.newPage()
    const errors: string[] = []
    report.on('pageerror', error => errors.push(error.message))
    const response = await report.goto(origin + '/report')
    expect(await response?.body()).toEqual(html)
    await expect.poll(() => report.locator('body').innerText()).toContain('Heading is visible')
    expect(errors).toEqual([])
    const isolation = await report.evaluate(() => {
      const local = localStorage.getItem('host-secret'), session = sessionStorage.getItem('host-session')
      localStorage.setItem('report-option', 'memory-only'); sessionStorage.setItem('session-option', 'memory-only')
      let cookieBlocked = false
      try { void document.cookie } catch { cookieBlocked = true }
      return { local, session, cookieBlocked, localValue: localStorage.getItem('report-option'), sessionValue: sessionStorage.getItem('session-option') }
    })
    expect(isolation).toEqual({ local: null, session: null, cookieBlocked: true, localValue: 'memory-only', sessionValue: 'memory-only' })
    await report.reload()
    await expect.poll(() => report.locator('body').innerText()).toContain('Heading is visible')
    expect(await report.evaluate(() => [localStorage.getItem('report-option'), sessionStorage.getItem('session-option')])).toEqual([null, null])
    expect(await host.evaluate(() => ({ local: localStorage.getItem('host-secret'), session: sessionStorage.getItem('host-session'), cookie: document.cookie }))).toEqual({ local: 'private', session: 'private', cookie: 'hostCookie=private' })
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
}
