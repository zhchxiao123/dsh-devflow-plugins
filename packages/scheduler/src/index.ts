import { Context, Service } from '@deepseek-ai/cordis'
import type { Plan, PlanInput, ScheduleHandler, Trigger } from './types.ts'
export type * from './types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: Scheduler
  }
}
/** Host-level scheduling seam. Providers persist intent before at-least-once delivery. */
export abstract class Scheduler extends Service {
  constructor(ctx: Context) {
    super(ctx, 'scheduler')
  }
  abstract registerHandler(name: string, handler: ScheduleHandler): () => void
  abstract create(input: PlanInput, actor: string): Promise<Plan>
  abstract update(id: string, input: PlanInput, actor: string): Promise<Plan>
  abstract list(): Promise<Plan[]>
  abstract pause(id: string, actor: string): Promise<void>
  abstract resume(id: string, actor: string): Promise<void>
  abstract remove(id: string, actor: string): Promise<void>
  abstract trigger(id: string, actor: string): Promise<Trigger>
  abstract history(id?: string): Promise<Trigger[]>
  abstract cancel(id: string, actor: string): Promise<void>
  /** Reconcile persisted due work immediately; the provider also invokes this without a chat. */
  abstract tick(): Promise<void>
}
export default Scheduler
