// A Service Definition is the one shape in this line that DOES default-export:
// the Loader reads the class off `default`, and a provider subclasses that
// same value. The function plugins elsewhere here assert the opposite, so this
// spec exists to keep a copy-paste from quietly turning the seam into neither.
import { describe, expect, it } from 'vitest'
import * as Mod from '@zhchxiao123/dsh-jev'
import { Service } from '@deepseek-ai/cordis'
import * as RunsPlugin from '../src/runs-plugin.ts'

describe('@zhchxiao123/dsh-jev plugin shape', () => {
  it('default-exports the service class', () => {
    expect('default' in Mod).toBe(true)
    expect(Mod.default).toBe(Mod.JevRuntime)
    expect(Object.getPrototypeOf(Mod.JevRuntime)).toBe(Service)
  })

  it('exports the contract helpers and the failure vocabulary', () => {
    expect(typeof Mod.assertRequest).toBe('function')
    expect(typeof Mod.retainAsked).toBe('function')
    expect(typeof Mod.JevError).toBe('function')
    expect(Mod.JEV_ERROR_CODES).toContain('JEV_ABORTED')
  })

  it('exposes ask as concrete and perform as the subclass obligation', () => {
    expect(typeof Mod.JevRuntime.prototype.ask).toBe('function')
    // `perform` is protected and abstract: nothing on the prototype, so a
    // subclass that forgets it fails at construction rather than at first call.
    expect('perform' in Mod.JevRuntime.prototype).toBe(false)
  })

  it('ships generic durable runs as an independently mountable plugin entry', () => {
    expect(RunsPlugin.name).toBe('jev-runs')
    expect(RunsPlugin.inject).toEqual(['jev', 'tools', 'jobs'])
    expect(typeof RunsPlugin.apply).toBe('function')
  })
})
