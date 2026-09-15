/** Preserve structured evidence when a short local credential is also a JSON literal or numeric substring. */
export function redactSecret(value: string, secret: string): string {
  if (!secret) return value
  if (secret.length >= 8) return value.replaceAll(secret, '[REDACTED]')
  if (value === secret) return '[REDACTED]'
  return value.replaceAll(JSON.stringify(secret), '"[REDACTED]"')
    .replaceAll(`Bearer ${secret}`, 'Bearer [REDACTED]').replaceAll(`bearer ${secret}`, 'bearer [REDACTED]')
}
