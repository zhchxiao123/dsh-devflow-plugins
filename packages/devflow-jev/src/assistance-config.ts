import type { AssistanceConfig } from './assistance-types.ts'

export function assistanceConfig(input: Partial<AssistanceConfig> = {}): AssistanceConfig {
  const config: AssistanceConfig = {
    mode: 'observe', timeoutMs: 5000, maxCallsPerTurn: 3, maxSteersPerTurn: 1,
    confidenceFloor: 0.75, maxBytes: 24000, maxFiles: 12, maxFileBytes: 4000, repeatThreshold: 2,
    ...input,
  }
  if (!['off', 'observe', 'assist'].includes(config.mode)) throw new Error('devflow-jev: invalid assistance mode')
  for (const key of ['timeoutMs', 'maxCallsPerTurn', 'maxSteersPerTurn', 'maxBytes', 'maxFiles', 'maxFileBytes', 'repeatThreshold'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`devflow-jev: assistance.${key} must be a positive integer`)
  }
  if (!Number.isFinite(config.confidenceFloor) || config.confidenceFloor < 0 || config.confidenceFloor > 1) throw new Error('devflow-jev: assistance.confidenceFloor must be between 0 and 1')
  if (config.maxFiles > 49) throw new Error('devflow-jev: assistance.maxFiles must leave room for scope within 50 JEV choices')
  return config
}
