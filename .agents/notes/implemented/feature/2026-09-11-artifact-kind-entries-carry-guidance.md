# Agent Note: artifact kind entries carry their own guidance

Status: implemented

## Problem

A kind spec could only name things. `sections: [Approach, Interfaces, Risks]`
told a producer that a heading called `Interfaces` must exist and nothing about
what belongs under it — signatures? callers? both? The gate published that list
as `devflowArtifactStructures` and the model's preflight rendered it verbatim,
so the one surface that reaches the producer at the moment it matters carried
three bare words.

The meaning lived in human-facing prose instead: the walkthrough, a README, a
skill body. A producer had to already know which document to open, which is the
opposite of what a preflight is for. And a deployment that invents its own kind
has nowhere to write the meaning down at all — its contract is configuration,
its explanation would have to be somewhere else.

## Decision

Each entry of `frontmatter`, `sections`, and `nonEmptySections` is either a bare
title or `{ title, description }`, and one list mixes both freely. The
description is published with the title and rendered under it in the preflight;
nothing checks it.

```yaml
    sections:
      - Approach
      - title: Interfaces
        description: the contracts this change adds or changes, and who calls them
```

### The checker is not told that descriptions exist

`validatedList` splits each list at validation time into two results: the bare
titles, which are the only thing `CheckedStructure` ever holds, and the entries
as configured, which are the only thing `publishedStructures` ever reads.
`structureDefects` and `frontmatterDefects` are unchanged to the line.

That split is the point of the design rather than an implementation detail. A
description is prose a person wrote to be helpful; if the checker could see it,
every future defect message, every comparison, every normalization would have
to decide what to do with it, and one of those decisions would eventually make
a passing artifact fail for how its spec was worded. Keeping the guidance out of
the checked shape makes "a description cannot change a verdict" a property of
the types instead of a promise in a doc. The existing structure and fault suites
needed no edit, which is the evidence that the split holds.

### The entry type lives in the core package

`ArtifactSectionSpec` and `ArtifactStructureEntry` are declared in
`packages/devflow/src/types.ts`, beside `PublishedArtifactKindStructure`, which
was already there. The alternative — define them in the gate and have the core
package import them — would point the Service Definition at a policy plugin,
inverting the seam this line is built on. A vocabulary type that a published
seam type references belongs with it.

The Definition-owned JSON Schema for the tool boundary,
`ARTIFACT_TRANSITION_INSPECTION_SCHEMA`, grew a matching
`ARTIFACT_STRUCTURE_ENTRY_SCHEMA` (`oneOf: [string, {title, description}]`).
That schema is what tells the model's runtime the shape of the field, so
leaving it saying `items: { type: 'string' }` would have published a lie about
output the gate can now actually produce.

### Rendering follows the spec-index precedent

`artifactGateLines` keeps flattening the titles onto one line and adds one
indented line per described entry — the presentation `specRefLines` already uses
for an optional description, so the tool has one convention rather than two. A
contract whose entries are all bare renders byte-for-byte what it rendered
before, which a composition test now asserts as a three-line block rather than
three independent substrings.

### The config schema is lenient and the hand validator is not

`Schema.union` is used here for the first time in this repository. Its object
member accepts an entry missing either field, and its failure message on a
genuine mismatch names the whole union rather than the field at fault. So the
schema settles the coarse shape and `validatedEntry` does the field-level work,
reporting `kinds["design"].sections[1].description must be a non-empty string` —
the naming discipline the rest of this gate's config errors already follow. It
reads its input as `unknown` for that reason: the declared type promises more
than the schema enforces, and pretending otherwise is how a null list item
becomes a crash instead of a message.

## Alternatives considered

**A parallel `sectionDescriptions: { Interfaces: ... }` map.** Keeps
`readonly string[]` and every downstream `.join(', ')` compiling. It also splits
one requirement across two config keys, needs its own check that the keys match
a title that exists, and makes the shape of a spec depend on whether anyone
wrote prose for it. The type break is a one-time cost on a pre-1.0 line; the
split shape is permanent.

**`field` rather than `title` for frontmatter entries.** Names the frontmatter
case more precisely, at the price of two entry types across three lists that are
otherwise identical. One type with a doc comment saying what `title` means in a
frontmatter list costs a reader one sentence; two types cost every reader and
every consumer a branch.

**Let the gate check descriptions somehow** — require a described section to be
longer, or to mention a word from its description. Every version of this turns
prose into a verdict, which is the agent gate's job and deliberately not this
one's. The mechanical layer stays mechanical.

**Put the guidance in the `devflow-workflow` skill instead.** No format change
at all, and it cannot work: the skill body deliberately states no deployment's
contract, because the contract is per-deployment configuration and the skill is
shipped code.

## Consequences

**The published TypeScript types are a breaking change.**
`PublishedArtifactKindStructure.sections` and its two siblings are now
`readonly ArtifactStructureEntry[]`. Downstream code doing `sections.join(', ')`
or `sections.map(s => s.trim())` stops compiling until it branches on the entry
shape — `typeof entry === 'string' ? entry : entry.title` is the whole of it.
Two published packages carry it, `@zhchxiao123/dsh-devflow` and
`@zhchxiao123/dsh-devflow-artifact-gate`; the one in-repo consumer,
`devflow-tool`, is fixed in the same change. Accepted deliberately on a pre-1.0
line rather than hidden behind a parallel field.

**YAML configuration is fully compatible.** Every existing contract — the
walkthrough's, both READMEs', every test's — is valid unchanged and behaves
identically, and the model-facing text it renders is byte-identical.

**A rollback is not symmetric.** Reverting this change makes a deployment that
has written object entries fail to load, because the old schema accepts only
strings. Rewrite such entries as bare titles before reverting.

**The `## Model Experience` surface grew a line per described entry.** That is
context spent on every preflight of that kind, in every tool result that
carries one. It is charged only where a deployment chose to write a description,
which is the right place for that decision to sit.
