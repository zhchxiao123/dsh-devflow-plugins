import { describe, expect, it, vi } from 'vitest'
import {
  DriverRegistry,
  RollbackUnsupportedError,
  UnknownKindError,
} from '../src/registry.ts'
import type { DeployOutcome, DeployRun, ResolvedTarget, RollbackClass, TargetDriver, TargetStatus } from '../src/types.ts'

interface FakeSpec {
  readonly marker: string
}

const RUN = {} as DeployRun

function fakeDriver(
  kind: string,
  rollbackClass: RollbackClass,
  withRollback: boolean,
): TargetDriver<FakeSpec> {
  const driver: TargetDriver<FakeSpec> = {
    kind,
    rollbackClass,
    validate: (spec, path) => {
      if (typeof spec !== 'object' || spec === null || !('marker' in spec)) {
        throw new Error(`${path}: expected a marker`)
      }
      return { marker: String(spec.marker) }
    },
    deploy: (_run, target) => Promise.resolve({ releaseId: `${target.name}-${target.spec.marker}` }),
    status: (_run, target) => Promise.resolve({
      name: target.name,
      kind,
      rollbackClass,
      releases: [{ id: target.spec.marker, current: true }],
    } satisfies TargetStatus),
  }
  if (!withRollback) return driver
  return {
    ...driver,
    rollback: (_run, target, to) => Promise.resolve({ releaseId: to ?? `${target.spec.marker}-prev` }),
  }
}

const ATOMIC: RollbackClass = { kind: 'atomic' }
const UNSUPPORTED: RollbackClass = { kind: 'unsupported', reason: 'the delegate decides reversibility' }

describe('DriverRegistry', () => {
  it('dispatches a registered kind without the core naming it', async () => {
    const registry = new DriverRegistry()
    registry.register(fakeDriver('fake', ATOMIC, true))

    const entry = registry.get('fake')
    const spec = entry.validate({ marker: 'v1' }, 'targets.demo')
    const outcome: DeployOutcome = await entry.deploy(RUN, 'demo', spec)

    expect(outcome.releaseId).toBe('demo-v1')
    expect(registry.kinds()).toEqual(['fake'])
  })

  it('hands the driver back exactly what validate produced', async () => {
    const registry = new DriverRegistry()
    const seen: ResolvedTarget<FakeSpec>[] = []
    const driver = fakeDriver('fake', ATOMIC, true)
    registry.register({
      ...driver,
      deploy: (run, target) => {
        seen.push(target)
        return driver.deploy(run, target)
      },
    })

    const entry = registry.get('fake')
    const spec = entry.validate({ marker: 'v1' }, 'targets.demo')
    await entry.deploy(RUN, 'demo', spec)

    expect(seen).toEqual([{ name: 'demo', spec: { marker: 'v1' } }])
    expect(seen[0]?.spec).toBe(spec)
  })

  it('reports an unknown kind against the registered ones', () => {
    const registry = new DriverRegistry()
    registry.register(fakeDriver('fake', ATOMIC, true))

    let caught: unknown
    try {
      registry.get('service')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(UnknownKindError)
    expect((caught as UnknownKindError).registered).toEqual(['fake'])
    expect((caught as Error).message).toContain('registered kinds: fake')
  })

  it('names no kinds when nothing is registered', () => {
    expect(() => new DriverRegistry().get('fake')).toThrow('registered kinds: (none)')
  })

  it('refuses a second driver for one kind', () => {
    const registry = new DriverRegistry()
    registry.register(fakeDriver('fake', ATOMIC, true))

    expect(() => registry.register(fakeDriver('fake', ATOMIC, true)))
      .toThrow('already registered')
  })

  it('unregisters on dispose and leaves a later registration alone', () => {
    const registry = new DriverRegistry()
    const dispose = registry.register(fakeDriver('fake', ATOMIC, true))

    dispose()
    expect(registry.kinds()).toEqual([])

    registry.register(fakeDriver('fake', ATOMIC, true))
    dispose()
    expect(registry.kinds()).toEqual(['fake'])
  })
})

describe('the rollback promise and its implementation', () => {
  it('refuses a driver that advertises a rollback it does not implement', () => {
    const registry = new DriverRegistry()

    expect(() => registry.register(fakeDriver('fake', ATOMIC, false)))
      .toThrow('advertises rollbackClass \'atomic\' but implements no rollback')
  })

  it('refuses a driver that implements a rollback it declares unsupported', () => {
    const registry = new DriverRegistry()

    expect(() => registry.register(fakeDriver('fake', UNSUPPORTED, true)))
      .toThrow('declares rollback unsupported but implements rollback')
  })

  it('rejects a rollback of an unsupported kind with the driver\'s reason', async () => {
    const registry = new DriverRegistry()
    registry.register(fakeDriver('playbook', UNSUPPORTED, false))
    const entry = registry.get('playbook')
    const spec = entry.validate({ marker: 'v1' }, 'targets.cluster')

    expect(entry.rollbackable).toBe(false)
    await expect(entry.rollback(RUN, 'cluster', spec))
      .rejects.toThrow(RollbackUnsupportedError)
    await expect(entry.rollback(RUN, 'cluster', spec))
      .rejects.toThrow('the delegate decides reversibility')
  })

  it('reaches no driver code when the rollback is unsupported', async () => {
    const registry = new DriverRegistry()
    const driver = fakeDriver('playbook', UNSUPPORTED, false)
    const status = vi.fn<TargetDriver<FakeSpec>['status']>((run, target) => driver.status(run, target))
    registry.register({ ...driver, status })
    const entry = registry.get('playbook')
    const spec = entry.validate({ marker: 'v1' }, 'targets.cluster')

    await expect(entry.rollback(RUN, 'cluster', spec)).rejects.toThrow(RollbackUnsupportedError)
    expect(status).not.toHaveBeenCalled()
  })

  it('reaches the driver\'s rollback and passes the requested release through', async () => {
    const registry = new DriverRegistry()
    registry.register(fakeDriver('fake', ATOMIC, true))
    const entry = registry.get('fake')
    const spec = entry.validate({ marker: 'v2' }, 'targets.demo')

    await expect(entry.rollback(RUN, 'demo', spec, 'v1')).resolves.toEqual({ releaseId: 'v1' })
    await expect(entry.rollback(RUN, 'demo', spec)).resolves.toEqual({ releaseId: 'v2-prev' })
  })

  it('carries a disruptive class through to status', async () => {
    const registry = new DriverRegistry()
    const disruptive: RollbackClass = { kind: 'disruptive', note: 'the container restarts' }
    registry.register(fakeDriver('service', disruptive, true))
    const entry = registry.get('service')
    const spec = entry.validate({ marker: 'v1' }, 'targets.api')

    expect(entry.rollbackable).toBe(true)
    await expect(entry.status(RUN, 'api', spec)).resolves.toMatchObject({ rollbackClass: disruptive })
  })
})
