# @zhchxiao123/dsh-devflow-jev-gate

English | [中文](README.zh.md)

Judgement policy on the [`ctx.devflow`](../devflow/README.md) transition waterfall: configured edges run the stage rubric through [`ctx.devflowJev`](../devflow-jev/README.md) and record the verdict in the transition journal's gate checks. The plugin is a pure Consumer — it adds no rubric, no storage, and no judgement machinery of its own.

## Behavior

Each configured edge names the assessments to run and one of two modes:

- **warn** (the starting point for every edge): the judgements are recorded as gate checks on the allowed transition — one line per assessment, naming the evaluation id so the full answers and any later human accept/reject stay reachable — and the move always proceeds. Warn records are the calibration data that must exist before anyone grants the model veto power.
- **enforce**: the move is vetoed only when an explicitly configured condition holds, and the veto reason carries the numbers that triggered it. An unavailable judgement vetoes only where the edge chose `failClosed: true`; an uncertain high risk score never vetoes below its configured confidence floor.

Unconfigured edges delegate untouched. A judgement that fails or misses its deadline can silence itself, never block by accident: on a warn edge it becomes an `unavailable` note on the passing move.

## Configuration

```yaml
- name: '@zhchxiao123/dsh-devflow-jev-gate'
  config:
    edges:
      - edge: developing->reviewing
        kinds: [review-scope, implementation-risk]
        mode: warn
        timeoutMs: 8000
      - edge: testing->done
        kinds: [release-readiness]
        mode: enforce
        timeoutMs: 8000
        failClosed: false
        veto:
          releaseBlockedMass: 0.5
```

`veto.releaseBlockedMass` vetoes when `P(blocked) + P(unavailable)` of the release judgement reaches the mass; `veto.riskScore` (with optional `veto.riskConfidence`) vetoes on a confident high `changeRisk` score. Every condition requires the edge to run the assessment that answers it — configuration fails loud at load otherwise.
