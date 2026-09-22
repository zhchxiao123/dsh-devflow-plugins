// A Service Provider carries both shapes: the Loader reads the class off
// `default`, and `name` / `inject` / `Config` are what a composition row
// addresses and validates against.
import { describe, expect, it } from 'vitest'
import * as Mod from '@zhchxiao123/dsh-jev-typesafe'
import JevRuntime from '@zhchxiao123/dsh-jev'

describe('@zhchxiao123/dsh-jev-typesafe plugin shape', () => {
  it('default-exports the provider class, which extends the seam', () => {
    expect('default' in Mod).toBe(true)
    expect(Mod.default).toBe(Mod.TypeSafeJev)
    expect(Object.getPrototypeOf(Mod.TypeSafeJev)).toBe(JevRuntime)
  })

  it('names itself and declares the credential seam as required', () => {
    expect(Mod.name).toBe('jev-typesafe')
    expect(Mod.inject).toEqual(['credentials'])
    expect(Mod.TypeSafeJev.Config).toBe(Mod.Config)
  })

  it('exports the wire translation for consumers that log or replay it', () => {
    for (const fn of [Mod.encodeState, Mod.encodeQuestions, Mod.decodeAnswer, Mod.decodeUsage, Mod.classify]) {
      expect(fn).toBeTypeOf('function')
    }
  })
})
