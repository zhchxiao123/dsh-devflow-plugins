import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type Scheduler from '@zhchxiao123/dsh-scheduler'
import { decodeInput } from './decode.ts'
/** Human-command consumer stays optional; background scheduling has no agent dependency. */
export function installCommand(ctx: Context, scheduler: Scheduler): void {
  ctx.inject(['commands'], (commandContext) => {
    // The conditional child exists only while commands is mounted.
    const commands = commandContext.commands
    commandContext.effect(() =>
      commands.register({
        name: 'scheduler',
        description: 'Manage host schedules and inspect delivery history',
        recordInput: false,
        input: {
          hint: 'list | create <JSON> | update <id> <JSON> | pause/resume/remove/trigger <id> | history [planId] | cancel <triggerId>',
        },
        handler: async (invocation) => {
          try {
            const input = invocation.rawInput.trim()
            const [action, id] = input.split(/\s+/)
            const actor = `command:${String(invocation.commandId)}`
            let result: unknown
            switch (action) {
              case 'list':
              case '':
                result = await scheduler.list()
                break
              case 'create':
                result = await scheduler.create(decodeInput(JSON.parse(input.slice('create'.length))), actor)
                break
              case 'update':
                if (!id) throw new Error('ID_REQUIRED')
                result = await scheduler.update(
                  id,
                  decodeInput(JSON.parse(input.slice(input.indexOf(id) + id.length))),
                  actor,
                )
                break
              case 'history':
                result = await scheduler.history(id)
                break
              case 'pause':
              case 'resume':
              case 'remove':
              case 'trigger':
              case 'cancel':
                if (!id) throw new Error('ID_REQUIRED')
                result = await scheduler[action](id, actor)
                break
              default:
                return {
                  kind: 'error',
                  text: 'Use /scheduler list | create <JSON> | update <id> <JSON> | pause/resume/remove/trigger <id> | history [planId] | cancel <triggerId>',
                }
            }
            return { kind: 'success', text: JSON.stringify(result ?? { ok: true }, null, 2) }
          } catch {
            return {
              kind: 'error',
              text: 'SCHEDULER_COMMAND_FAILED: check identifiers, JSON parameters, schedule rule and handler availability.',
            }
          }
        },
      }),
    )
  })
}
