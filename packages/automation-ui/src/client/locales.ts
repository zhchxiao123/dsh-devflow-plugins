/** Copy is local to the Automation page, independent of the Devflow board. */
export const NS = 'automation'
export const zh = {
  unassigned: '未归属项目的旧数据', claim: '认领到当前项目', claimHint: '认领会将此记录及历史绑定到当前项目；关联订阅应先认领。',
  renderError: '面板显示异常，请重新加载。',
  title: '自动化', description: '管理当前项目的定时计划与投递记录。', githubDescription: '订阅 GitHub 仓库，查看同步内容与运行。', noProject: '请先在项目中打开或创建会话。', scheduleSync: '设置定时同步', deliveries: '投递记录',
  subscriptions: 'GitHub 订阅', plans: '定时计划', runs: '运行记录', refresh: '刷新', loading: '正在加载…',
  stale: '刷新失败，以下保留上次读取的数据。', empty: '暂无记录', unavailable: '服务未加载，请在当前 profile 启用对应插件。',
  add: '新建', edit: '编辑', save: '保存', close: '关闭', pause: '暂停', resume: '恢复', sync: '立即同步', trigger: '立即执行', remove: '删除计划',
  cancel: '取消运行', repository: '仓库 owner/repo', credential: '凭证引用（env:TOKEN）', issues: 'Issues', discussions: 'Discussions',
  name: '计划名称', subscription: 'GitHub 订阅', rule: '时间规则', interval: '固定间隔', cron: 'Cron', minutes: '间隔（分钟）', expression: 'Cron 表达式', timezone: '时区',
  enabled: '启用', paused: '已暂停', next: '下次执行', content: '同步内容', source: '查看 GitHub 原文', back: '返回',
  storage: '主机共享存储容量', capacity: '容量上限（字节）', blocked: '容量受限，请调整上限后恢复运行', used: '已用',
  pages: '页', objects: '条内容', retries: '次重试', wait: '等待至', error: '错误', detail: '详情', saved: '操作已生效',
  scope: '当前项目' , generic: '此计划使用其他处理器；编辑时间规则会保留其参数。',
  confirmRemove: '确认删除计划', removeHint: '计划将停止触发，运行记录会保留。', completed: '完成时间', started: '接收时间', lastSuccess: '上次同步成功',
  queued: '排队中', running: '运行中', waiting: '等待中', succeeded: '已成功', partial: '部分完成', failed: '失败', cancelled: '已取消', pending: '待投递', delivering: '投递中', accepted: '已接收',
} as const
export type AutomationKey = keyof typeof zh
export const en: Record<AutomationKey, string> = {
  unassigned: 'Legacy records without a project', claim: 'Claim for this project', claimHint: 'Claiming binds this record and its history to this project. Claim linked subscriptions first.',
  renderError: 'The panel could not render. Try reloading.',
  title: 'Automation', description: 'Manage this project’s schedules and deliveries.', githubDescription: 'Subscribe to GitHub repositories and inspect synced content and runs.', noProject: 'Open or create a session in a project first.', scheduleSync: 'Schedule sync', deliveries: 'Delivery history', subscriptions: 'GitHub subscriptions', plans: 'Schedules', runs: 'Run history', refresh: 'Refresh', loading: 'Loading…',
  stale: 'Refresh failed. Showing the last successful read.', empty: 'No records yet', unavailable: 'Service unavailable. Enable its plugin in this profile.',
  add: 'New', edit: 'Edit', save: 'Save', close: 'Close', pause: 'Pause', resume: 'Resume', sync: 'Sync now', trigger: 'Run now', remove: 'Delete schedule', cancel: 'Cancel run',
  repository: 'Repository owner/repo', credential: 'Credential reference (env:TOKEN)', issues: 'Issues', discussions: 'Discussions', name: 'Schedule name', subscription: 'GitHub subscription', rule: 'Time rule', interval: 'Fixed interval', cron: 'Cron', minutes: 'Interval (minutes)', expression: 'Cron expression', timezone: 'Timezone',
  enabled: 'Enabled', paused: 'Paused', next: 'Next run', content: 'Synced content', source: 'View on GitHub', back: 'Back', storage: 'Host-wide shared storage capacity', capacity: 'Capacity limit (bytes)', blocked: 'Storage full. Increase capacity, then resume the run.', used: 'Used', pages: 'pages', objects: 'objects', retries: 'retries', wait: 'Waiting until', error: 'Error', detail: 'Details', saved: 'Change applied', scope: 'Current project', generic: 'This schedule uses another handler. Editing its time rule preserves its parameters.', confirmRemove: 'Confirm deletion', removeHint: 'The schedule will stop triggering. Run history is retained.', completed: 'Completed at', started: 'Accepted at', lastSuccess: 'Last successful sync', queued: 'Queued', running: 'Running', waiting: 'Waiting', succeeded: 'Succeeded', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled', pending: 'Pending', delivering: 'Delivering', accepted: 'Accepted',
}
export type Translate = (key: AutomationKey) => string
