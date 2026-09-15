/**
 * The report projection, driven by a real Playwright `json` report rather than
 * a hand-written sample. The fixture was produced by running a deliberately
 * red three-case suite under Playwright 1.61.1 with `--reporter=json`; a
 * fabricated sample would not have shown that the runner writes terminal
 * colour codes into `error.message` while leaving `error.snippet` clean, which
 * is the single fact this projection exists to handle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseReport } from '../src/report-parser.ts'

const PLAYWRIGHT_REPORT = readFileSync(
  fileURLToPath(new URL('fixtures/playwright-report.json', import.meta.url)),
  'utf8',
)

/** The escape byte the runner writes, built rather than typed so no control character lands in source. */
const ESC = String.fromCharCode(27)

describe('parseReport, playwright-json', () => {
  it('names every failed case and leaves the passing one out', () => {
    const { failures, diagnostics } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    expect(diagnostics).toEqual([])
    expect(failures.map(failure => failure.title)).toEqual([
      'login redirects to the dashboard',
      'cart › totals include tax',
    ])
  })

  it('addresses a case inside a describe block by its whole path', () => {
    const { failures } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    expect(failures[1]).toMatchObject({ title: 'cart › totals include tax', file: 'checkout.spec.js', line: 14, column: 3 })
  })

  it('strips the terminal colour codes the runner writes into a message', () => {
    const { failures } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    // The file stores the escape byte as a JSON escape; it becomes a control character on parse.
    expect(PLAYWRIGHT_REPORT).toContain('\\u001b')
    expect(failures[0]?.message).not.toContain(ESC)
    expect(failures[0]?.message).toContain('Expected: "/dashboard"')
    expect(failures[0]?.message).toContain('Received: "/login?error=1"')
  })

  it('keeps the snippet with its failing-line marker', () => {
    const { failures } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    expect(failures[0]?.snippet).toContain("> 10 |   expect('/login?error=1').toBe('/dashboard')")
  })

  it('carries every attachment with the media type that decides how it reaches the model', () => {
    const { failures } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    expect(failures[0]?.attachments?.map(entry => [entry.name, entry.contentType])).toEqual([
      ['screenshot', 'image/png'],
      ['trace', 'application/zip'],
      ['error-context', 'text/markdown'],
    ])
    expect(failures[0]?.attachments?.[0]?.path).toMatch(/screenshot-[0-9a-f]+\.png$/)
  })

  it('carries the error context the runner attaches to a failure that attached nothing itself', () => {
    const { failures } = parseReport(PLAYWRIGHT_REPORT, 'playwright-json')
    expect(failures[1]?.attachments?.map(entry => entry.name)).toEqual(['error-context'])
  })

  it('degrades an unparseable report into a diagnostic, never a throw', () => {
    const { failures, diagnostics } = parseReport('{ not json', 'playwright-json')
    expect(failures).toEqual([])
    expect(diagnostics[0]).toMatch(/^the report is not parseable JSON: /)
  })

  it.each([
    { label: 'a JSON scalar', text: '42' },
    { label: 'an array root', text: '[]' },
    { label: 'a mapping without suites', text: '{"stats":{}}' },
  ])('names $label as the wrong shape for this format', ({ text }) => {
    const { failures, diagnostics } = parseReport(text, 'playwright-json')
    expect(failures).toEqual([])
    expect(diagnostics).toEqual(['the report is not a Playwright JSON report (no top-level suites list)'])
  })

  it('skips report entries that are not shaped like suites, specs, tests, or results', () => {
    const text = JSON.stringify({
      suites: [
        5,
        // A file of nothing but describe blocks carries no specs of its own.
        { suites: [{ title: 'only nesting', specs: [{ ok: false, title: 'inner' }] }] },
        {
          specs: [7, { ok: true, title: 'passing' }, { ok: false, title: 'bare' }],
          suites: [
            9,
            { title: 'nested', specs: [{ ok: false, title: 'deep', tests: [3, { results: [4, {}] }] }] },
          ],
        },
      ],
    })
    const { failures, diagnostics } = parseReport(text, 'playwright-json')
    expect(diagnostics).toEqual([])
    expect(failures.map(failure => failure.title)).toEqual(['only nesting › inner', 'bare', 'nested › deep'])
    expect(failures[1]).toEqual({ title: 'bare' })
  })

  it('reports the error of the last attempt, so a retry that settled the case wins', () => {
    const text = JSON.stringify({
      suites: [{
        specs: [{
          ok: false,
          title: 'flaky',
          tests: [{
            results: [
              { error: { message: 'first attempt' } },
              { error: { message: 'second attempt' }, attachments: [{ path: '/tmp/a.png', contentType: 'image/png' }] },
            ],
          }],
        }],
      }],
    })
    const { failures } = parseReport(text, 'playwright-json')
    expect(failures[0]?.message).toBe('second attempt')
    expect(failures[0]?.attachments).toEqual([{ name: '/tmp/a.png', path: '/tmp/a.png', contentType: 'image/png' }])
  })

  it('drops an attachment that names no file or no media type', () => {
    const text = JSON.stringify({
      suites: [{
        specs: [{
          ok: false,
          title: 'partial',
          tests: [{ results: [{ attachments: [5, { name: 'no path' }, { path: '/tmp/b.png' }] }] }],
        }],
      }],
    })
    expect(parseReport(text, 'playwright-json').failures[0]).not.toHaveProperty('attachments')
  })
})
