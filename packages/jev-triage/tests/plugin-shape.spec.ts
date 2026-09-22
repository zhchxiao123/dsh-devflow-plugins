// A Consumer is a function plugin: no default export. Mixing the two forms
// makes the Loader discard the namespace, which fails as "this plugin does
// nothing" rather than as an error.
import { describe, expect, it } from 'vitest'
import * as Mod from '@zhchxiao123/dsh-jev-triage'

describe('@zhchxiao123/dsh-jev-triage plugin shape', () => {
  it('exports the function-plugin surface and no default', () => {
    expect('default' in Mod).toBe(false)
    expect(Mod.name).toBe('jev-triage')
    expect(Mod.inject).toEqual(['tools', 'jev', 'shell'])
    expect(typeof Mod.apply).toBe('function')
    expect(typeof Mod.Config).toBe('function')
  })

  it('names no provider package anywhere in its surface', () => {
    expect(Object.keys(Mod).join(' ')).not.toContain('typesafe')
  })
})
