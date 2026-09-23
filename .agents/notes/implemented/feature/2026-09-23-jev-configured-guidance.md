# Agent Note: Configured JEV guidance for ordinary development

Status: implemented

## Problem

Exposing judgement tools does not tell the Harness agent when they improve a development task. Users should not need to spell out tool calls, while unconditional instructions would advertise unusable capabilities and encourage repetitive evaluations.

## Decision

The JEV service exposes a provider-neutral asynchronous configuration status with an unknown default. TypeSafe resolves its configured credential reference through its captured Harness credential service. The status reveals neither a secret nor a provider error and performs no remote authentication probe. Configured credentials establish eligibility for guidance, not proof that the provider can answer.

The existing generic runs and Devflow plugins own optional system-prompt contributions. Each plugin registers an empty ordered context and resolves configuration asynchronously in the system-prompt assembly waterfall. It delegates first and fills only its own surviving context, checking the current agent's workspace and tool visibility without caching agent state. Harness assembles prompts before agent/pre-step, so refreshing only in that later event would omit guidance from the first model call and retain removed credentials for another step. Missing services, credentials, or tools suppress the associated instructions; unloading a plugin removes its contribution. The generic package remains independent of Devflow.

Guidance describes evidence collection, material request and design uncertainty, risky implementation changes, and delivery review. Existing records and unchanged evidence should be reused; trivial work does not require a judgement. Run status, failures, and incomplete coverage remain explicit. Judgements do not replace test execution, accept proposals, or authorize stage transitions.

## Alternatives considered

- A static skill or unconditional prompt would recommend tools even when credentials or session capabilities were absent.
- Checking TYPESAFE_API_KEY directly in consumers would bypass credential providers and bind generic JEV to one vendor.
- A remote readiness probe would add latency and possible cost without proving the next judgement will succeed.
- Mandatory evaluation hooks would create a workflow policy rather than guidance for the existing Harness executor.

## Consequences

The change adds no package, model tool, or durable data format. Provider integrations that do not implement configuration status continue working but do not advertise automatic guidance. Credential rotation is reflected when the underlying provider exposes its new value; changing an external shell variable cannot mutate a running process.

Composition tests verify assembled instructions, credential changes, visibility, isolation, and disposal. These tests establish prompt delivery, not the model's probability of choosing useful calls. A fresh natural-language development task remains the acceptance test for invocation quality and decision value.
