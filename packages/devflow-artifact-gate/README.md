# @zhchxiao123/dsh-devflow-artifact-gate

English | [中文](README.zh.md)

Artifact-contract policy on the [`devflow/transition`](../devflow/README.md) waterfall: a configured edge requires registered artifact kinds, and the newest registration of each required kind must pass a mechanical structure check — the configured frontmatter fields present, the configured `## ` section titles found. The plugin is a read-only Consumer of the `ctx.devflow` seam; it writes nothing, decides one waterfall, and publishes its kind specs as a service so a producer can shape a deliverable to the same spec the gate will check.

## Behavior

For an attempt on edge `from->to` with an `edges` entry, the gate reads the moving card and checks every required kind against the newest registration of that kind — the record with the highest journal revision, as written by `devflow_attach_artifact`'s kind + content form; path-only registrations carry no kind and never match. A kind with no registration, a registered file the disk does not serve, a missing frontmatter block or field, and a missing section are each one defect, and the veto lists **all** of them at once (`<kind>: <what>`, naming the file), so one rework round sees the whole gap instead of one item per attempt. Earlier registrations of a kind are history, not evidence: a structurally whole newest registration passes regardless of what its predecessors look like.

An edge with no `edges` entry delegates without reading the card, and a card that passes every check delegates untouched — later policies (command gates, approvals) decide as if this plugin were absent. A veto is not a commit: the card stays where it was, at its revision, with no journal entry.

The check is structural only: fields present with a value, section headings present as `## <title>` lines (trailing whitespace allowed). Whether the content under them is any good is a different layer's question.

## Config

```yaml
- id: devflow-artifact-gate
  name: '@zhchxiao123/dsh-devflow-artifact-gate'
  config:
    specs:
      prd:
        frontmatter: [card, kind, title]
      design:
        frontmatter: [card, kind, title]
        sections: [Approach, Compatibility]
    edges:
      'draft->designing': [prd]
      'designing->ready': [prd, design]
```

| Key | Default | Meaning |
|---|---|---|
| `specs` | `{}` | Structure spec per artifact kind: `frontmatter` fields that must be present with a value, and `sections` titles (without `## `) that must appear. Both lists optional; an empty list equals omission, and a kind declared with neither is required only to be registered. |
| `edges` | `{}` | Artifact kinds each `from->to` edge requires. An edge with no entry — or an empty list — is not gated. |

Misconfiguration fails the load, naming the config item: an edge key not of the form `<from>-><to>` with known location names (`blocked` is legal on either side — a recovery edge can carry a contract too), an edge requiring a kind `specs` does not declare, a kind key outside the seam's kind grammar (lowercase letters, digits, and dashes, starting alphanumeric), or a blank entry in a `frontmatter`/`sections` list.

A kind no edge references is legal: it exists purely as a published spec, for deliverables that are templated but not gated.

## The kind-spec service

The validated `specs` — normalized (empty lists dropped) and deep frozen — are published as the optional `devflowArtifactSpecs` service. A producer reads it with `ctx.get('devflowArtifactSpecs')` and feeds the same field and section lists into whatever writes the deliverable, so the template and the check cannot drift apart; the service disappears with the plugin's fiber. Types (`ArtifactKindSpec`, `ArtifactSpecs`) are exported for type-only import.

## Model Experience

None, as a contract veto reaches a model only through the devflow tools' rejection text; this plugin registers no prompt or schema.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Waterfall order is deployment load order** — this mechanical layer should be composed ahead of slower layers (command gates, approvals, any agent check), so a missing artifact vetoes before a test suite runs or a human is asked. Nothing enforces that order; the deployment's row order does.
- **Structure only, no semantics** — a present field may hold nonsense and a present section may be empty prose; judging content is a separate (agent-side) layer, not this one.
- **The contract sees only journal-registered kinds** — a deliverable written into the card directory without `attachArtifact`'s kind + content form does not exist for this gate, by design: the journal is the authority on what was delivered.
