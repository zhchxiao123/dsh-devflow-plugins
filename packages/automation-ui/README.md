# Automation sidebar

English | [中文](README.zh.md)

Adds **Automation** to the native DeepSeek Harness right sidebar, using its page registry and keyed body slot. The page shows all subscriptions and schedules on the connected host, independently of the active chat workspace. Devflow's existing board remains a separate page.

Compose with `dsh-automation-web`, `dsh-scheduler-local`, and `dsh-github-sync-local`. The browser bundle requires Harness `0.1.5-rc.2`; build at the repository root before packaging. Missing services are shown explicitly.

The GitHub tab creates subscriptions, changes sync scope and credential references, pauses/resumes intake, synchronizes on demand, and reads content as text with safe source links. Credentials are references such as `env:GITHUB_TOKEN`; secret values never enter this page.

Schedules support interval and Cron rules with explicit timezones, manual execution, pause/resume, and deletion with retained history. Creating a plan selects a GitHub subscription. Editing an existing handler's schedule preserves its parameters.

Run history exposes status, timestamps, page/object/retry counts, waits, errors, receipts, cancellation, and resumption of failed/partial GitHub runs. Capacity can be adjusted from the GitHub tab. Mutations call the same public services as agent tools, then reread committed state.

Overview and content reads each permit one pending request, so slow responses survive polling ticks. Write errors remain visible until dismissed or another action is attempted; successful overview reads do not clear content or write errors. Only visible panes poll; hidden browser documents skip refresh, hidden panes abort reads, and unmount disposes timers and listeners. A failed refresh retains the previous data with an explicit stale message. Browser plugin `refreshMs` defaults to 5000 and accepts integer milliseconds from 100 through 2147483647.
