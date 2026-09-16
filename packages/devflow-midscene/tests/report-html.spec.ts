import { expect, it } from 'vitest'
import { sandboxReportHtml } from '../src/report-html.ts'
it('places memory-only storage before SDK scripts while preserving doctype and dump bytes', () => {
  for (const html of ['<!doctype html><head><script>sdk()</script></head>', '<HTML><HEAD class="report"><script>sdk()</script></HEAD></HTML>', '<script>sdk()</script>']) {
    const output = sandboxReportHtml(html)
    expect(output.indexOf('data-devflow-report-storage')).toBeLessThan(output.indexOf('sdk()'))
    expect(output).toContain('<script>sdk()</script>')
    if (html.startsWith('<!doctype')) expect(output.startsWith('<!doctype')).toBe(true)
  }
})
