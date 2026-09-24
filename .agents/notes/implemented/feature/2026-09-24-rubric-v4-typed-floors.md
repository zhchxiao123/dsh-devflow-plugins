# Agent Note: Rubric v4 — temporal facts to code, floors split by answer type

Status: implemented

## Problem

Rubric v3 carried three systematic deviations from the judgement model's published guidance. `testEvidenceFresh` asked the model a revision-comparison question the journal already answers, on a documented model weakness. The intake gate averaged a pseudo-confidence across all answers — deriving |p−0.5|×2 from Nouls, mixing it with Choice/Score distribution confidence, and letting the `serviceClass` preference spread push automatable assessments into manual review. Stage rubric Nouls shipped without contrastive criteria, leaving the yes/no boundary to the model.

## Decision

Rubric v4. The freshness question is gone: `evidence.ts` computes "a test-report artifact is registered at or after the current stage revision" from journal facts, `evidenceState` hands it to the model as an observation, and the audit aggregate raises the deterministic `test-evidence-stale` warning itself for test-impact and release-readiness evaluations. A journal truncated by the evidence budget can only produce a false "stale", never a false "current".

Confidence floors are split by the scale they read: `choiceConfidenceFloor` and `scoreConfidenceFloor` replace the shared `confidenceFloor`, Nouls are thresholded on probability alone, and no floor ever gates an answer of another type. Each decision path checks only the answers it consumes; `serviceClass` sits outside every gate and outside the recorded confidence, which is now the minimum distribution concentration of the consumed Choice/Score answers (0 for an incomplete assessment, 1 where only Nouls were asked). Every stage Noul carries contrastive true/false criteria. A policy override naming an unknown field — including the retired `confidenceFloor` — fails at boot instead of gating nothing.

## Alternatives considered

- Keeping a derived Noul confidence with its own floor: rejected — the derivation is exactly the cross-scale reuse the failure modes document.
- Per-question probability floors for every stage Noul: rejected for now; `informationFloor` doubling as the generic yes-floor is a known coarseness the calibration exporter can justify refining later.
- Firing the stale warning for every assessment kind: rejected — only test-impact and release-readiness consume test evidence; elsewhere it is noise.

## Consequences

RUBRIC_VERSION is 4; audit check identities carry the version, so existing runs and records stay readable and comparisons across versions stay honest. Deployments overriding `policy.confidenceFloor` fail loud at boot and must choose which typed floor they meant. The judgement gate is untouched: its veto conditions read stable answer ids. Threshold values themselves remain hand-set until the calibration exporter (#38) produces per-type evidence.
