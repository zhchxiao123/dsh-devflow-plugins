/** Devflow adapters keep the generic run registry independent of project workflow state. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@zhchxiao123/dsh-jev/runs-plugin'
import type {} from './assistance.ts'

export function registerSources(ctx: Context): void {
  const runs = ctx.get('jevRuns')
  if (runs === undefined) return
  ctx.inject(['devflowAssistance'], (child) => {
    const assistance = child.devflowAssistance
    child.effect(() => runs.registerSource('devflow-assistance', {
      list: async project => (await assistance.list(project)).map(record => ({ id: record.id, record })),
      read: (project, id) => assistance.read(project, id),
    }))
  })
  ctx.effect(() => runs.registerSource('devflow-audit', {
    list: async project => (await ctx.devflowJev.listAudits(join(project, '.devflow'))).map(record => ({ id: record.manifest.id, record })),
    read: (project, id) => ctx.devflowJev.inspectAudit(join(project, '.devflow'), id),
    run: (project, input, owner) => ctx.devflowJev.startAudit(join(project, '.devflow'), input, owner),
    control: (project, id, action, owner) => ctx.devflowJev.controlAudit(join(project, '.devflow'), id, action, owner),
  }))
  ctx.effect(() => runs.registerSource('devflow-assessment', {
    list: async project => (await ctx.devflowJev.list(join(project, '.devflow'))).map(record => ({ id: record.id, record })),
    read: (project, id) => ctx.devflowJev.read(join(project, '.devflow'), id),
  }))
}
