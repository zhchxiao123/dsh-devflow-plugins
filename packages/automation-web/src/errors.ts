/** Only fixed domain messages cross HTTP. Unknown provider/driver errors may contain paths or credentials. */
const SAFE_ERRORS = new Set([
  'PROJECT_CONTEXT_REQUIRED', 'WORKSPACE_SERVICE_UNAVAILABLE', 'PROJECT_NOT_REGISTERED', 'SESSION_CONTEXT_UNAVAILABLE', 'SESSION_NOT_FOUND', 'PROJECT_MISMATCH', 'PROJECT_REQUIRED', 'PROJECT_ALREADY_ASSIGNED',
  'scheduler-unavailable', 'github-sync-unavailable', 'subscription-repository-mismatch',
  'HANDLER_UNAVAILABLE', 'PLAN_NOT_FOUND', 'PLAN_PAUSED', 'TRIGGER_NOT_FOUND', 'NAME_AND_HANDLER_REQUIRED',
  'INVALID_LIMIT', 'INVALID_INTERVAL', 'FIVE_FIELD_CRON_REQUIRED', 'JSON_PARAMS_REQUIRED',
  'Unknown subscription', 'Unknown run', 'Subscription paused', 'Storage capacity reached',
  'Select at least one content type', 'Cancel active runs before changing scope',
  'Create a new subscription to change repository identity', 'Only failed or partial runs can resume',
  'Another synchronization is pending; finish it before resuming',
  'Subscription scope changed; start a new synchronization',
  'Newer synchronization changed content; start a new synchronization',
  'Credential reference unavailable', 'Invalid capacity',
])
export function publicError(error: unknown): string {
  return error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'Automation operation failed; check configuration and host logs'
}
