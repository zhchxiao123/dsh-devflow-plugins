import { expect, it } from 'vitest'
import { redactSecret } from '../src/secret-redaction.ts'
it('scrubs secret values while preserving short-secret numeric and boolean metadata', () => {
  expect(redactSecret('unchanged', '')).toBe('unchanged')
  expect(redactSecret('long-secret anywhere', 'long-secret')).toBe('[REDACTED] anywhere')
  expect(redactSecret('a', 'a')).toBe('[REDACTED]')
  for (const secret of ['true', '1234', 'a']) {
    const value = JSON.stringify({ secret, ok: true, count: 1234, header: `Bearer ${secret}`, lower: `bearer ${secret}` })
    expect(JSON.parse(redactSecret(value, secret))).toEqual({ secret: '[REDACTED]', ok: true, count: 1234, header: 'Bearer [REDACTED]', lower: 'bearer [REDACTED]' })
  }
})
