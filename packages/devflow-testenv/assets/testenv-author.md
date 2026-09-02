# testenv Author

Derive an integration-test plan from code evidence and, once the user approves it, write the project's first service-bound integration tests — the suite `testenv-bootstrap` needs before it can choose one. This skill is invoked after the bootstrap survey eliminates every candidate, or when the user asks for integration tests to be written; the plan requires approval before any code is written. Those are two separate consent gates: reaching the plan report never implies permission to write code, and a bootstrap zero-candidate outcome never invokes this skill on its own. What to test is decided by code evidence, the behavioral baseline is confirmed by running the code, and whether to test at all is the user's call.

## 1. Survey the code

Three inventories establish the evidence the plan is built from; nothing enters the plan later without appearing here first.

**Service surface.** Enumerate every externally reachable entry point from the code itself: route registrations, controllers, OpenAPI documents, CLI entry points, queue consumers, scheduled jobs. Enumerate from the repository, not from general knowledge of what such a project usually has — an assumed endpoint produces a test for a service that does not exist.

**Data flows.** Trace the chains where multiple components collaborate through persistent state — a request that writes through a repository and is read back by another component, a queue message that mutates a store a route later serves. Pure in-memory logic stays with unit tests: an integration test that a unit test could express pays the environment's cost for nothing.

**Existing tests.** Mine the current suites for the project's runner, its fixture and factory conventions, and its domain vocabulary and assertion style. A suite written in a foreign dialect gets rewritten instead of extended.

## 2. Derive the plan from evidence

Every candidate scenario carries a code anchor: the source file path that evidences it, line number optional. A scenario without a code anchor does not enter the plan — an unanchored scenario is an assumption wearing a plan's clothes.

Rank the anchored candidates by how many components the chain crosses, how much persistent state participates, and how important the entry point is to the product. Take the top one to three: golden paths through the deepest seams, not coverage — coverage is what the unit suites are for.

## 3. The approval gate

Report the plan in the session — not in a file — and stop. Not one line of test code is written before the user approves the plan. The report carries the scenarios with their anchors, the files that will be created or modified, the new dependencies (aim for zero; the project's existing runner and fixtures usually suffice), and where the tests read their service endpoints from.

Compact form (generic example, not a template to copy verbatim):

```text
Scenario — an order placed over HTTP is persisted and adjusts the stock level.
  Anchors: src/routes/orders.ts (route registration); src/repos/order-repo.ts
           (the write); src/jobs/stock-sync.ts (the read-back).
  Files: tests/integration/orders.spec.ts (new);
         package.json (adds the test:integration script).
  New dependencies: none — the existing vitest runner and pg fixtures cover it.
  Endpoints: API_BASE_URL and DATABASE_URL, read from the environment as
             src/config.ts already does.
```

An approved plan authorizes exactly its own scenarios; widening the suite is a new plan through the same gate.

## 4. Write the tests, then prove them empirically

Write the approved scenarios with the project's own runner and conventions from section 1. Two rules bind every test body:

- **Assert product behavior across the service boundary.** A connectivity-only assertion — the endpoint answered, the status was 2xx — proves the environment is up, not that the product works; the bootstrap loop already proves the environment.
- **Read service endpoints from environment variables or configuration**, never hardcode them — the bootstrap's binding analysis recognizes a suite as service-bound by exactly that construction.

Then prove the baseline by running: start the real environment, run the suite, and get it green. A mismatch between what the code intends and what the running system does is a finding to report to the user — a potential bug — never something to silently encode into an assertion; an assertion that pins observed-but-unintended behavior turns the bug into a contract.

Wire the suite to a `test:integration` script in `package.json`, or the project's equivalent convention (a Makefile target, a tox environment) — the bootstrap manifest's `test` field needs a stable command to name.

## 5. Hand back to bootstrap

End by directing the user to run `testenv-bootstrap`. The new suite is now the only service-bound candidate, so the bootstrap's fast path holds: it writes the manifest, proves the `env_up → env_status → env_down` loop, and falsifies the binding — with the environment down, the new suite must turn red. This skill writes tests; the manifest and its proof belong to bootstrap, so the two records never disagree about who owns the environment knowledge.

## When no seam is worth an integration test

A survey may find nothing that merits one: a pure library or pure-algorithm project with no persistent state and no service boundary has no seam an integration test would exercise. Report that outcome and stop — this skill does not apply, together with what would have to change for it to apply. Do not manufacture a seam to have tests to deliver; a fixture service that exists only to be tested reads as an integration gate the project does not have.
