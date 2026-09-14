# devflow-spec-bootstrap

Bootstrapping is the cold-start case the incremental judgment does not cover:
a scope the `/devflow spec` census lists with no document at all. The
`devflow-spec-authoring` skill owns what deserves a document and how anchors
are chosen; the `dsh-write-spec` skill owns the write protocol and how to
read a refusal. This skill owns only the procedure that takes an uncovered
scope from zero to a small anchored set — it repeats neither.

## 1. One scope at a time

Take one uncovered scope from the census — or the one a human names — and
finish it before opening another. Bootstrapping works by holding a whole
scope's code in view at once; splitting that attention across scopes yields
documents that describe none of them well.

## 2. Read the code, not the old documents

Establish what is true today from the source, in this order:

1. the package's README and contributor notes — the claimed contracts, taken
   as questions to verify, not as answers;
2. `src/types.ts` — the vocabulary: unions, discriminants, service shapes;
3. the export surface — what the package promises outward;
4. the test titles — the behaviors someone already found worth pinning.

Do not mine legacy design documents, wikis, or stale comments for claims. A
document inherits the reliability of its sources, and prose copied from an
unverified one starts life defending statements nobody checked. The code is
the only source a born-fresh anchor can vouch for.

## 3. What to look for

In descending order of value per byte:

- **Seam contracts** — a capability's definition, provider, and consumer
  roles and which module owns each. This knowledge spans files, so no single
  file states it.
- **Closed vocabularies** — unions, code sets, and state sets that are
  closed on purpose, where adding a member is a design decision rather than
  an edit.
- **Cross-file rules** — a single write path, where validation lives, an
  ordering two modules must agree on. These break silently when one side
  moves alone.
- **Deliberate surprises** — a design that looks wrong until its reason is
  known. Record the reason: without it the design reads as a defect and
  invites a "fix".

## 4. Write few, write anchored

Start with at most three documents per scope. A bootstrap that lands ten is
describing the code file by file, which the code already does better, and
every extra document is surface someone must later merge away.

Hold each candidate to the write skill's bar — decidable, non-obvious, and
would be violated by a competent stranger — and choose anchors by the
authoring skill's order, writability first, then strength. Land each
document through `devflow_write_spec` as you go rather than batching drafts.
When a write is refused, fix the anchor, not the claim: per the
`dsh-write-spec` skill, a refusal at write time almost always means a
mistyped symbol or a wrong path, not a wrong sentence.

## Non-TypeScript scopes

The census discovers scopes across ecosystems — Python, Go, Rust, JVM and
more — but anchor evaluation is TypeScript/JavaScript-only: `symbol` and
`content-hash` anchors resolve through a TS parser, so outside that language
they are refused at write time and `churn` is the only anchor kind such a
scope can carry. Bootstrap these scopes with the same procedure, three
consequences accepted up front:

- **Freshness lags commits.** A churn anchor compares a file's last commit
  against the document, so the document is still born fresh, but drift shows
  only after the changed file is committed — never while it is being edited.
  The census marks such scopes `churn-only; freshness lags commits`; that
  line is this trade-off restated, not a defect to fix.
- **The turn-end sentinel never fires here.** It reads only `symbol` and
  `content-hash` verdicts, so nothing will ever interrupt a turn on these
  documents' behalf — the `/devflow spec` census is the only thing that
  reports them stale. Re-run it deliberately after working in such a scope.
- **Every churn anchor is a future false alarm.** Any commit touching the
  file flips it, typo and redesign alike, and someone must re-verify the
  claim each time. Be more restrained than section 4 already demands: fewer
  documents, and anchor only the load-bearing files whose change genuinely
  reopens the claim.

The section-2 reading order translates rather than lapses: where TypeScript
offers `src/types.ts` and the export surface, read Python's `__init__`
re-exports, typing surface, and model classes; Go's exported identifiers and
interfaces; Rust's `pub` items and traits. What counts as a claim
(section 3) does not change at all.

## 5. Done, or honestly unfinished

The scope is bootstrapped when the `/devflow spec` census no longer lists it
as uncovered — that is the whole completion criterion, and it is mechanical.
Stopping partway is a legitimate state, not a failure: the census keeps
reporting the remaining gap, so unfinished work stays visible without
depending on anyone's memory. What is not legitimate is silencing the gap
line with a placeholder — a document that claims nothing protects nothing,
and it spends bytes someone must later merge away.
