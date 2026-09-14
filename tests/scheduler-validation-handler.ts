/** A registered external handler for tests that configure plans without executing work. */
import type Scheduler from '@zhchxiao123/dsh-scheduler'
export function registerValidationHandler(scheduler: Scheduler, name: string): () => void {
  return scheduler.registerHandler(name, {
    validate() {},
    async accept() { throw new Error('This fixture only validates configuration') },
    async status() { return { state: 'running' } },
    async cancel() {},
  })
}
