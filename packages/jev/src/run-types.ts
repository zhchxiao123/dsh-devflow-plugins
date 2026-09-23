import type { Agent } from '@deepseek-ai/dsh-agent'

export interface JevRunInput {
  readonly source?: string
  readonly definitionJson?: string
  readonly title?: string
  readonly evidence?: string
  readonly questions?: readonly string[]
  readonly profile?: string
  readonly maxCards?: number
}
export interface JevListRecord { readonly source: string; readonly id: string; readonly record: unknown }
export interface JevControlResult { readonly runId: string; readonly jobId?: string; readonly outcome?: string }
/** Adapter arguments use the workspace directory, never a storage subdirectory. */
export interface JevRunSource {
  list(project: string): Promise<readonly { readonly id: string; readonly record: unknown }[]>
  read(project: string, id: string): Promise<unknown>
  run?(project: string, input: JevRunInput, owner: Agent): Promise<unknown>
  control?(project: string, id: string, action: 'resume' | 'cancel', owner: Agent): Promise<JevControlResult>
}
