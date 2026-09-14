/** Tool wire schemas project public service records without exposing provider state. */
export const text = { type: 'string', required: true } as const
export const integer = { type: 'integer', required: true } as const
export const boolean = { type: 'boolean', required: true } as const
export const subscription = {
  type: 'object', additionalProperties: false,
  properties: { id: text, repository: text, credentialRef: { type: 'string' }, issues: boolean, discussions: boolean, actor: text, paused: boolean, revision: integer, lastSuccessAt: { type: 'integer' }, lastReconcileAt: { type: 'integer' } },
} as const
export const snapshot = {
  type: 'object', additionalProperties: false,
  properties: { id: text, subscriptionId: text, kind: { ...text, enum: ['issue', 'issue-comment', 'discussion', 'discussion-comment', 'discussion-reply'] }, parentId: { type: 'string' }, url: text, updatedAt: text, title: text, body: text, state: text, version: integer, fingerprint: text, fetchedAt: integer, deleted: boolean },
} as const
export const run = {
  type: 'object', additionalProperties: false,
  properties: { subscriptionSnapshot: { ...subscription, required: true }, id: text, subscriptionId: text, triggerId: text, actor: text, acceptedAt: integer, status: { ...text, enum: ['queued', 'running', 'waiting', 'succeeded', 'partial', 'failed', 'cancelled'] }, checkpointSequence: integer, pageBudget: integer, pages: integer, objects: integer, retries: integer, fence: integer, leaseUntil: integer, owner: text, reconcile: boolean, completedAt: { type: 'integer' }, error: { type: 'string' }, waitUntil: { type: 'integer' } },
} as const
export const receipt = { type: 'object', additionalProperties: false, properties: { runId: text, acceptedAt: integer } } as const
export const storage = { type: 'object', additionalProperties: false, properties: { bytes: integer, capacityBytes: integer, blocked: boolean, error: { type: 'string' }, capacityChangedBy: { type: 'string' }, capacityChangedAt: { type: 'integer' } } } as const
export const consumer = { subscriptionId: text, consumerId: text } as const
export const position = { ...text, enum: ['beginning', 'now'] } as const
export const cursor = { type: 'object', additionalProperties: false, properties: { acknowledged: integer, delivered: integer } } as const
export const change = { type: 'object', additionalProperties: false, properties: { sequence: integer, id: text, subscriptionId: text, objectId: text, version: integer, type: { ...text, enum: ['created', 'updated', 'deleted'] }, snapshot: { ...snapshot, required: true } } } as const
