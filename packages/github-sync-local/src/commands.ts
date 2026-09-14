/** Deterministic management commands never interpret synchronized text as instructions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type GitHubSync from '@zhchxiao123/dsh-github-sync'
export function installCommands(ctx: Context, sync: GitHubSync): void {
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register({
      name: 'github-sync',
      description: 'Manage GitHub subscriptions, runs and durable consumers',
      input: {
        hint: '[list|add owner/repo [issues|discussions|all] [env:TOKEN]|update id issues|discussions|all [env:TOKEN]|sync id|show run|runs [id]|pause id|resume id|resume-run run|cancel run|content id|storage|capacity bytes|consumer id name beginning|now|cursor id name|changes id name limit|ack id name sequence|replay id name beginning|now]',
      },
      handler: async (invocation) => {
        const [verb = 'list', ...args] = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        const [first = '', second = '', third = ''] = args
        const actor = `command:github-sync:${invocation.agent.session.header.id}`
        try {
          const arities: Record<string, readonly [number, number]> = {
            list: [0, 0], add: [1, 3], update: [2, 3], sync: [1, 1], show: [1, 1], runs: [0, 1],
            pause: [1, 1], resume: [1, 1], cancel: [1, 1], content: [1, 1],
            storage: [0, 0], capacity: [1, 1], consumer: [3, 3], replay: [3, 3],
            cursor: [2, 2], changes: [3, 3], ack: [3, 3], 'resume-run': [1, 1],
          }
          const arity: readonly [number, number] = (Object.hasOwn(arities, verb) ? arities[verb] : undefined) ?? [0, 3]
          if (args.length < arity[0] || args.length > arity[1]) throw new Error('Invalid command argument count')
          let result: unknown
          switch (verb) {
            case 'list':
              result = await sync.subscriptions()
              break
            case 'add':
            case 'update': {
              const mode = second || 'issues'
              if (!['issues', 'discussions', 'all'].includes(mode))
                throw new Error('Expected issues, discussions, or all')
              const input = {
                issues: mode !== 'discussions',
                discussions: mode !== 'issues',
                actor,
                ...(third ? { credentialRef: third } : {}),
              }
              result = verb === 'add'
                ? await sync.createSubscription({ repository: first, ...input })
                : await sync.updateSubscription(first, input)
              break
            }
            case 'sync':
              result = await sync.sync(first, { actor })
              break
            case 'resume-run':
              result = await sync.resumeRun(first, actor)
              break
            case 'show':
              result = await sync.run(first)
              break
            case 'runs':
              result = await sync.runs(first || undefined)
              break
            case 'pause':
            case 'resume':
              result = await sync.updateSubscription(first, {
                paused: verb === 'pause',
                actor,
              })
              break
            case 'cancel':
              await sync.cancel(first, actor)
              result = { cancelled: first }
              break
            case 'content':
              result = await sync.snapshots(first)
              break
            case 'storage':
              result = await sync.storage()
              break
            case 'capacity':
              result = await sync.setCapacity(Number(first), actor)
              break
            case 'consumer':
            case 'replay': {
              if (third !== 'beginning' && third !== 'now')
                throw new Error('Expected beginning or now')
              if (verb === 'consumer')
                await sync.registerConsumer(first, second, third)
              else await sync.replay(first, second, third)
              result = await sync.consumerState(first, second)
              break
            }
            case 'cursor':
              result = await sync.consumerState(first, second)
              break
            case 'changes':
              result = await sync.readChanges(first, second, Number(third))
              break
            case 'ack':
              await sync.acknowledge(first, second, Number(third))
              result = await sync.consumerState(first, second)
              break
            default:
              throw new Error('Unknown github-sync command')
          }
          return {
            kind: 'success',
            text: JSON.stringify(result ?? null, null, 2),
          }
        } catch (error) {
          return {
            kind: 'error',
            text: String(error),
          }
        }
      },
    })
  })
}
