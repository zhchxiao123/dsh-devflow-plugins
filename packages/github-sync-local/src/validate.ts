/** Decode persisted records before they can influence ownership or consumer position. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid durable object')
  return value as Record<string, unknown>
}
function text(row: Record<string, unknown>, ...keys: string[]): void {
  for (const key of keys)
    if (typeof row[key] !== 'string') throw new Error(`Invalid durable ${key}`)
}
function integer(row: Record<string, unknown>, ...keys: string[]): void {
  for (const key of keys)
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)
      throw new Error(`Invalid durable ${key}`)
}
export function validate(value: unknown): void {
  const row = record(value)
  if ('snapshot' in row) {
    text(row, 'subscriptionId', 'objectId')
    integer(row, 'version')
    if (!['created', 'updated', 'deleted'].includes(String(row.type)))
      throw new Error('Invalid durable change type')
    validate(row.snapshot)
    const snapshot = record(row.snapshot)
    if (
      snapshot.id !== row.objectId ||
      snapshot.subscriptionId !== row.subscriptionId ||
      snapshot.version !== row.version
    )
      throw new Error('Change snapshot mismatch')
    return
  }
  if ('kind' in row) {
    text(
      row,
      'id',
      'subscriptionId',
      'url',
      'updatedAt',
      'title',
      'body',
      'state',
      'fingerprint',
    )
    integer(row, 'version', 'fetchedAt')
    if (
      ![
        'issue',
        'issue-comment',
        'discussion',
        'discussion-comment',
        'discussion-reply',
      ].includes(String(row.kind)) ||
      typeof row.deleted !== 'boolean' ||
      row.version === 0 ||
      (row.parentId !== undefined && typeof row.parentId !== 'string')
    )
      throw new Error('Invalid durable snapshot')
    return
  }
  if ('triggerId' in row) {
    validate(row.subscriptionSnapshot)
    text(row, 'id', 'subscriptionId', 'triggerId', 'actor', 'owner')
    integer(
      row,
      'acceptedAt',
      'pages',
      'objects',
      'retries',
      'fence',
      'leaseUntil',
      'pageBudget',
      'checkpointSequence',
    )
    if (
      ![
        'queued',
        'running',
        'waiting',
        'succeeded',
        'partial',
        'failed',
        'cancelled',
      ].includes(String(row.status)) ||
      typeof row.reconcile !== 'boolean'
    )
      throw new Error('Invalid durable run')
    for (const key of ['waitUntil', 'completedAt'])
      if (row[key] !== undefined) integer(row, key)
    if (row.error !== undefined) text(row, 'error')
    return
  }
  if (row.projectId === undefined) row.projectId = null
  if (row.projectId !== null && (typeof row.projectId !== 'string' || !row.projectId.trim())) throw new Error('Invalid durable projectId')
  text(row, 'id', 'repository', 'actor')
  integer(row, 'revision')
  if (
    typeof row.paused !== 'boolean' ||
    typeof row.issues !== 'boolean' ||
    typeof row.discussions !== 'boolean' ||
    row.revision === 0
  )
    throw new Error('Invalid durable subscription')
  for (const key of ['lastSuccessAt', 'lastReconcileAt'])
    if (row[key] !== undefined) integer(row, key)
}
