/**
 * The driver registry behind the target-type seam. Drivers register by kind;
 * the tools dispatch through here and never name a kind themselves, which is
 * what keeps adding a deployment kind a registration rather than a change to
 * the core.
 *
 * Registration is where the rollback promise is checked against the
 * implementation: a driver whose {@link RollbackClass} is not `unsupported`
 * must implement `rollback`, and one that is must not. The check runs here
 * rather than in the `./invariant` companion because it is a structural
 * relation of the registration itself, with no event stream to observe.
 */

import type {
  DeployOutcome,
  DeployRun,
  ResolvedTarget,
  RollbackClass,
  TargetDriver,
  TargetStatus,
} from './types.ts'

/** A registered driver with its spec type erased behind the registry's own dispatch. */
export interface DriverEntry {
  readonly kind: string
  readonly rollbackClass: RollbackClass
  /** True when this kind promises a rollback; mirrors `rollbackClass.kind !== 'unsupported'`. */
  readonly rollbackable: boolean
  validate(spec: unknown, path: string): unknown
  deploy(run: DeployRun, name: string, spec: unknown): Promise<DeployOutcome>
  status(run: DeployRun, name: string, spec: unknown): Promise<TargetStatus>
  rollback(run: DeployRun, name: string, spec: unknown, to?: string): Promise<DeployOutcome>
}

/** Thrown when a manifest names a kind no driver has registered. */
export class UnknownKindError extends Error {
  /** Kinds registered when the lookup failed, in registration order. */
  readonly registered: readonly string[]

  constructor(kind: string, registered: readonly string[]) {
    super(
      `unknown target kind '${kind}'; registered kinds: ${
        registered.length === 0 ? '(none)' : registered.join(', ')
      }`,
    )
    this.name = 'UnknownKindError'
    this.registered = registered
  }
}

/** Thrown when a rollback is asked of a kind that does not promise one. */
export class RollbackUnsupportedError extends Error {
  constructor(kind: string, reason: string) {
    super(`target kind '${kind}' does not support rollback: ${reason}`)
    this.name = 'RollbackUnsupportedError'
  }
}

/** Builds the entry's rollback face, enforcing that the promise matches the implementation. */
function rollbackFace<S>(
  driver: TargetDriver<S>,
  bind: (name: string, spec: unknown) => ResolvedTarget<S>,
): DriverEntry['rollback'] {
  const { kind, rollbackClass } = driver
  if (rollbackClass.kind === 'unsupported') {
    if (driver.rollback !== undefined) {
      throw new Error(
        `driver '${kind}' declares rollback unsupported but implements rollback; `
        + 'an implemented rollback must advertise \'atomic\' or \'disruptive\'',
      )
    }
    const { reason } = rollbackClass
    return () => Promise.reject(new RollbackUnsupportedError(kind, reason))
  }
  const implementation = driver.rollback
  if (implementation === undefined) {
    throw new Error(
      `driver '${kind}' advertises rollbackClass '${rollbackClass.kind}' but implements no rollback; `
      + 'omitting rollback is how a kind declares itself unsupported',
    )
  }
  return (run, name, spec, to) => implementation(run, bind(name, spec), to)
}

/** Registered deployment kinds, keyed by kind name. */
export class DriverRegistry {
  private readonly entries = new Map<string, DriverEntry>()

  /**
   * Register one deployment kind.
   * @param driver - the kind's implementation.
   * @returns the registration's disposer.
   * @throws {Error} when the kind is already registered, or when the driver's
   *   rollback promise and implementation disagree.
   */
  register<S>(driver: TargetDriver<S>): () => void {
    if (this.entries.has(driver.kind)) {
      throw new Error(`target kind '${driver.kind}' is already registered`)
    }
    const { rollbackClass } = driver
    // The cast is confined here: `validate` is the only producer of a spec of
    // type S, and the registry hands back exactly what that call returned.
    const bind = (name: string, spec: unknown): ResolvedTarget<S> => ({ name, spec: spec as S })
    const entry: DriverEntry = {
      kind: driver.kind,
      rollbackClass,
      rollbackable: rollbackClass.kind !== 'unsupported',
      validate: (spec, path) => driver.validate(spec, path),
      deploy: (run, name, spec) => driver.deploy(run, bind(name, spec)),
      status: (run, name, spec) => driver.status(run, bind(name, spec)),
      rollback: rollbackFace(driver, bind),
    }
    this.entries.set(driver.kind, entry)
    return () => {
      if (this.entries.get(driver.kind) === entry) this.entries.delete(driver.kind)
    }
  }

  /** Registered kind names, in registration order. */
  kinds(): readonly string[] {
    return [...this.entries.keys()]
  }

  /**
   * Look up the driver for one kind.
   * @param kind - the manifest's declared kind.
   * @returns the registered entry.
   * @throws {UnknownKindError} naming every registered kind.
   */
  get(kind: string): DriverEntry {
    const entry = this.entries.get(kind)
    if (entry === undefined) throw new UnknownKindError(kind, this.kinds())
    return entry
  }
}
