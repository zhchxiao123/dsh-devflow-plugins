# @zhchxiao123/dsh-automation-project

## Project ownership

Automation belongs to the current session's registered Harness workspace. Its stable workspace ID is resolved host-side from the session header cwd; callers cannot select a project ID or create a workspace implicitly. Missing context rejects. Sessions in the same registered workspace share plans and subscriptions; different workspaces remain isolated. Background execution continues independently of the viewing session.

Legacy unassigned records are listed separately and require explicit claim into the current project. Claim pauses the record; resume is a separate action. GitHub storage capacity is shared across the host, not a project quota.
