# Response fixtures

Each file here is one System One response body, used to write the decoder
against bytes rather than against prose.

**Provenance, stated plainly: these were built from `@typesafe-ai/sdk@0.6.0`'s
own `dist/index.d.mts`, not captured from a live call.** That declaration file
is the vendor's machine-readable contract for the same wire — it is what
`SystemOneResult`, `ScoreResponse`, `ChoiceResponse`, `NoulResponse`, and
`Usage` are declared as — so it is a stronger source than documentation prose.
It is still not a recording.

The risk this leaves: a field the vendor returns but does not declare, or a
declared field the service omits in practice, would not appear here. Replace
each file with a real capture on the first run against the live endpoint
(`tests/typesafe.e2e.ts` is that run), and record the `model` value it came
back with.

| File | What it stands for | Source |
|---|---|---|
| `score-choice-noul.json` | one of each question type answered | `dist/index.d.mts` @ 0.6.0 |
| `partial.json` | a question the service did not answer, and one it answered unreadably | `dist/index.d.mts` @ 0.6.0 |
