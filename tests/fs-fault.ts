/** Filesystem operations whose infrastructure failures are injected by specs. */
export type FaultableFsOperation = 'mkdir' | 'readFile' | 'readdir'

interface PendingFsFault {
  readonly operation: FaultableFsOperation
  readonly path: string
}

const pending: PendingFsFault[] = []

/** Make the next matching filesystem operation reject on every host OS. */
export function injectFsAccessDenied(fault: PendingFsFault): void {
  pending.push(fault)
}

/** Run one real operation unless its exact operation/path fault is pending. */
export function runWithFsFault<T>(
  operation: FaultableFsOperation,
  path: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const normalizedPath = typeof path === 'string' ? path : ''
  const fault = takeFsFault(operation, normalizedPath)
  return fault === undefined ? run() : Promise.reject(fault)
}

function takeFsFault(operation: FaultableFsOperation, path: string): NodeJS.ErrnoException | undefined {
  const index = pending.findIndex(fault => fault.operation === operation && fault.path === path)
  if (index < 0) return undefined
  const fault = pending[index]
  if (fault === undefined) return undefined
  pending.splice(index, 1)
  return Object.assign(new Error(`EACCES: injected ${operation} failure for ${path}`), { code: 'EACCES' })
}

/** Keep an unconsumed fault from leaking into the next spec. */
export function resetFsFaults(): void {
  pending.length = 0
}
