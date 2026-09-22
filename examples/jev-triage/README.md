# Running jev_triage before it is published

[`triage.mjs`](triage.mjs) calls the tool against a real repository with the
same composition a deployment uses — the local subprocess and bash executors,
the tools registry, `jev-typesafe`, and `jev-triage`. It exists because these
packages are not on npm yet, so `dsh plugin add` has nothing to install.

```sh
pnpm install
pnpm run build                      # the script imports the built lib/, not src/
TYPESAFE_API_KEY=sk-… node examples/jev-triage/triage.mjs /absolute/path/to/repo [base-ref]
```

Without a key it still runs, and reports the failure it is supposed to report:

```
jev_triage: 2 file(s) — 2 to review, 0 skipped
REVIEW  README.md  [judgement unavailable (JEV_CREDENTIAL_MISSING)]
REVIEW  auth.ts  [judgement unavailable (JEV_CREDENTIAL_MISSING)]
Note: The judgement call failed, so every file it covered defaults to review.
```

That is the whole contract in one screen: with no judgement available, nothing
is skipped.

## What this script is not

The key comes from `process.env` here because a standalone script has no
credential store to read. **The plugin never touches `process.env`** — it
resolves `apiKeyRef` through `ctx.credentials` on every call, so a deployment
composes a real credential provider and gets rotation for free. `EnvCredentials`
in this file has no equivalent in a real composition.

The imports are relative paths into `packages/*/lib/` for the same reason: the
workspace root does not link these packages by name, and neither would a
deployment until they are installed. Once published, a profile composes them as
ordinary rows:

```yaml
- jev-typesafe:
    apiKeyRef: TYPESAFE_API_KEY
- jev-triage:
    skipBelow: 2
    confidenceFloor: 0.4
```

Those two rows are the whole deployment. `jev-typesafe` is a subclass of the
seam's base class, so mounting it registers `ctx.jev` — there is no third row
for `@zhchxiao123/dsh-jev` itself.
