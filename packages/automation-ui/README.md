# Project automation and GitHub sidebar pages

English | [中文](README.zh.md)

Adds two independent native DeepSeek Harness right-sidebar pages: **Automation** (`automation`) for schedules and delivery history, and **GitHub subscriptions** (`github-subscriptions`) for subscriptions, synced content, and synchronization history. Devflow remains a separate page.

Every request carries the real sidebar session ID. The host resolves its registered workspace and returns the project identity shown above the controls. Sessions in the same project share records; another project has its own records. Missing context prompts the user to open a project session and never falls back to a host-wide view. Background execution remains host-managed when pages are closed.

Compose with `dsh-automation-web`, `dsh-scheduler-local`, and `dsh-github-sync-local`. The browser bundle requires published Harness `0.1.5-rc.2`; build at the repository root before packaging. Missing services are shown explicitly.

GitHub subscriptions support scope and credential-reference editing, pause/resume, manual synchronization, plain-text content and safe source links. Credentials are references such as `env:GITHUB_TOKEN`; secret values never enter the page. **Schedule sync** opens the native Automation tab with that subscription selected. Subscription-linked plans and delivery-linked runs navigate between native tabs using their session-bound actions.

Schedules support intervals, timezone-specific Cron, manual execution, pause/resume, and deletion with retained history. Creating a plan selects a project subscription. Editing an existing handler's schedule preserves its parameters. Synchronization history exposes status, timestamps, page/object/retry counts, waits, errors, cancellation, and resumption of failed/partial runs. Delivery history remains distinct from synchronization completion.

Legacy records are displayed only after requesting **Legacy records without a project**. Each claim is explicit and binds the record and its history to the current project; linked subscriptions must be claimed before their plans. GitHub storage capacity is explicitly labelled **Host-wide shared storage capacity** because this limit spans projects.

Overview and content each permit one pending read. Hidden panes abort reads; unmount clears timers and listeners. Session/navigation changes reset the component lifetime; a changed project binding clears old forms and content and ignores obsolete write results. Refresh errors retain prior data with a stale warning, except missing project context removes the old view. Write and content errors survive independent successful overview polls. Browser plugin `refreshMs` defaults to 5000 and accepts integer milliseconds from 100 through 2147483647.
