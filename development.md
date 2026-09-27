# Development

This document owns the durable engineering decisions for `qawarness`: architecture, boundaries, development philosophy, runtime choices, verification expectations, and testing policy.

Exact scenario formats, individual action schemas, CLI flags and other concrete contracts should ultimately live close to their implementation and the tests that pin them. Do not duplicate every implementation detail here.

## Purpose

`qawarness` is a local agentic QA harness.

Its first target is web applications. React Native and other mobile applications should be supportable later without replacing the agent, scenario, verification, recording, or diagnosis layers.

The intended architecture is:

```text
QA Scenario
    ↓
Agent / Planner
    ↓
platform-neutral QA environment
    ↓
execution backend
    ↓
normalized observation
    ↓
deterministic verification + narrow model judgments
    ↓
evidence
    ↓
result classification
```

Expected execution backends:

```text
QAEnvironment
├── PlaywrightEnvironment
├── DetoxEnvironment
└── AppiumEnvironment
```

Only Playwright is required initially.

## LLM provider boundary

The agent layer must depend on the provider-neutral `LLMProvider` contract. Provider
adapters translate requests and responses at the API boundary; DeepSeek is the first
adapter, not a permanent dependency of the agent or QA layers.

```text
Agent → LLMProvider → configured provider
Agent → QAEnvironment → configured execution backend
```

The agent should remain independent of both the LLM vendor and the QA execution
platform. Provider integration and QA execution remain separate until the agent layer
connects them. Keep credentials in environment configuration and network smoke checks
explicit because they require an external service.

## Toolchain

Use:

- Bun as runtime
- Bun as package manager
- TypeScript
- Playwright for the web backend
- Chromium for initial development

Bun executes TypeScript directly. Do not introduce a second TypeScript runtime such as `tsx` without a real requirement.

Keep dependencies small.

## Core boundary

Higher-level code must not know that Playwright exists.

Core code should speak in concepts such as:

- QA action
- semantic selector
- QA observation
- environment
- action result
- execution record
- proof
- verification result

The following are backend implementation details and must not leak through the core contract:

- `Page`
- `Locator`
- `Browser`
- `BrowserContext`
- Playwright selector strings
- arbitrary Playwright JavaScript

The intended direction is:

```text
caller
  ↓
QAEnvironment
  ↓
PlaywrightEnvironment
  ↓
Playwright
```

not:

```text
caller
  ↓
Playwright Page
```

A future mobile environment should be able to satisfy the same conceptual contract without redesigning the rest of the harness.

## Semantic interaction

The system should expose restricted semantic actions rather than arbitrary browser automation code.

Conceptually:

```text
navigate
click
type / fill
select
press
scroll
inspect
screenshot
done
```

A semantic click may internally resemble:

```ts
{
  type: "click",
  target: {
    by: "role",
    role: "button",
    name: "Create customer"
  }
}
```

Selector preference is:

```text
role + accessible name
    ↓
label
    ↓
text
    ↓
test id
    ↓
CSS
    ↓
coordinates
```

Coordinates are an escape hatch, not a normal strategy.

Do not expose arbitrary Playwright evaluation or generated Playwright source code to the future agent.

## Observation

Execution backends produce a normalized observation.

The observation should contain useful state such as:

- platform
- URL, title or route where meaningful
- relevant text
- useful semantic elements
- screenshot reference when captured
- application/browser errors

Do not attempt to serialize the entire DOM simply because it is available.

Do not implement a custom accessibility system if the underlying platform already provides meaningful semantic information.

The observation should contain enough information for navigation and verification without becoming an uncontrolled state dump.

## Execution and verification are separate

Completing an interaction sequence is not the same thing as proving success.

A future agent may emit:

```ts
{
  type: "done",
  reason: "Customer details page appears to contain the requested customer"
}
```

`done` means:

> The execution layer believes the requested workflow has been completed and is ready to be verified.

It does not mean:

```text
PASS
```

The intended flow is:

```text
execution
    ↓
done
    ↓
verification
    ↓
passed / product failure / agent failure / harness failure / inconclusive
```

A wrong `done` decision should eventually be diagnosable as an agent failure rather than being treated as a product success.

`done` therefore must not be translated into a Playwright browser operation.

The execution layer owns `done` and writes it to the action log. Environments receive
only interaction actions. An environment returns a structured failure for an ordinary
action failure; an unavailable environment throws so execution can stop after recording
the failed step. A `done` record is a completion signal, never a verification result.

## Scenario philosophy

Scenario instruction and proof should remain separate.

Conceptually:

```yaml
name: create-customer

instruction: |
  Create a customer named John Smith
  using john@example.com.

proof:
  - customer details page is visible
  - name is John Smith
  - email is john@example.com

maxSteps: 30
```

The instruction tells the execution agent what to accomplish.

The proof tells the verifier what must actually be true.

Execution agents receive the instruction and observations, never the proof. Scenario
files are validated before the browser or provider starts. Local application servers
are started externally; the CLI connects to an already-running URL.

The agent receives only restricted semantic QA tools. Every model tool call is
untrusted and validated before execution. The loop is observe → one action → observe;
ordinary action failures return to the agent for recovery. `done` starts independent
verification and never implies a pass. Deterministic proof checks come before any
model-based verification. Current run statuses describe execution outcomes, not the
eventual product-versus-agent failure diagnosis taxonomy.

Do not let the execution agent's belief substitute for proof.

## Model responsibilities

Model responsibilities stay narrow.

The primary LLM may perform:

- planning
- navigation
- selecting semantic actions
- recovering from ordinary interaction problems

Jev should not directly control the browser.

Jev is intended for narrow judgments over structured or textual state such as:

- Has the task completed?
- What application state are we in?
- Does this look like an application error?
- Does the observation satisfy a particular proof?
- Should execution continue or stop?

Do not send Jev screenshots directly unless the architecture is intentionally changed later.

Keep model execution behind the provider and environment boundaries.

## Evidence

The harness should preserve evidence including:

- screenshots
- execution actions
- normalized observations
- verification output
- console errors
- page errors
- failed network requests
- URL / route information
- Playwright trace where useful

Evidence should help answer:

> What happened, what did the agent do, what did the application return, and why was this result classified this way?

Do not implement every possible artifact immediately.

Add evidence capabilities when they materially improve diagnosis.

## Recording

Actions and their results should be recorded outside the platform-specific adapter where practical.

An append-friendly format such as JSONL is preferred for execution logs because a crash during a run should not invalidate records already written.

A useful record can include:

- sequence
- action
- timing
- success/failure
- error
- resulting observation

Recording is not the responsibility of the future LLM.

Recording is not inherently a Playwright concern.

## Durable run history

MongoDB is the structured history store. The runner accesses it through a narrow
`RunStore` boundary; the agent, verifier, provider, and environment do not depend on
MongoDB. The filesystem remains the evidence store. Screenshots and Playwright traces
stay in `runs/<run-id>/`, with paths referenced from MongoDB. JSONL and report files
remain portable without database access.

Scenario definitions are versioned and effectively append-only. The same normalized
content reuses its version; changed content creates a new version. Every run references
its definition and embeds a snapshot. Steps are separate documents written immediately
after execution. A running record without a final status indicates interruption. The
execution result is retained if later diagnosis is added; full model transcripts and
schema migration machinery are deferred until needed. With MongoDB enabled, a failed
initial write prevents execution, and a later write failure is surfaced after filesystem
evidence and run finalization are attempted.

For local MongoDB, start `docker run -d --name qawarness-mongo -p 27017:27017 mongo:8`
or use any reachable MongoDB server. Set `MONGODB_URI=mongodb://localhost:27017` and
`MONGODB_DB=qawarness`, then run `bun run db:init`. Without `MONGODB_URI`, the QA CLI
uses filesystem-only mode. Future schema changes may require explicit migrations.

Useful `mongosh qawarness` queries:

```js
db.runs.find({ "scenario.name": "sign-in" }).sort({ startedAt: -1 }).limit(10)
db.run_steps.find({ runId: "<run-id>" }).sort({ sequence: 1 })
db.scenario_definitions.find({ name: "sign-in" }).sort({ version: 1 })
```

## Failure model

The eventual diagnosis vocabulary is:

```text
passed
product_failure
agent_failure
harness_failure
inconclusive
```

These classifications are intentionally not implemented prematurely.

Rough conceptual meanings:

`passed`
: Required proof is satisfied.

`product_failure`
: The application behaved incorrectly or prevented the requested workflow.

`agent_failure`
: The application appears capable of satisfying the scenario, but the execution agent failed to accomplish it correctly.

`harness_failure`
: The QA infrastructure itself failed, for example an execution backend malfunction.

`inconclusive`
: Available evidence is insufficient to assign another result confidently.

Execution and diagnosis should ultimately be distinct layers.

## Testing philosophy

Do not optimize for test count or coverage percentage.

The project needs a good test surface, not a large test suite.

Prefer tests that protect:

- architectural boundaries
- externally meaningful behavior
- selector/action semantics
- recording behavior
- failure handling
- verification behavior once verification exists

Avoid tests for:

- obvious TypeScript structures
- getters and setters
- simple forwarding functions
- every theoretically possible selector combination
- internal implementation details
- visual styling
- markup snapshots with no business meaning
- speculative mobile behavior before mobile support exists

At the early stage, a small number of smoke tests can be better than dozens of unit tests.

Typical high-value checks currently include:

```text
typecheck

environment smoke:
    launch Chromium
    navigate
    observe
    screenshot
    close

action smoke:
    navigate through semantic action API
    perform a semantic interaction
    obtain normalized observation
    record execution
```

Add tests when they buy confidence in something important.

## Development philosophy

Prefer concrete requirements over speculative generality.

Do not create an abstraction merely because another implementation might theoretically exist one day. The major platform boundary is intentional because mobile support is a real goal; smaller abstractions should earn their place.

Keep related behavior easy to read together.

Avoid tiny single-use helpers when inline code is clearer.

Use names that communicate domain intent.

Validate at real boundaries.

Handle real failures, but do not build elaborate recovery paths for states ruled out by established contracts.

Do not over-engineer infrastructure before the current milestone requires it.

A future requirement is not automatically a current requirement.

## Current development direction

Development should progress roughly in this order:

```text
1. Environment boundary
   Playwright-backed QAEnvironment
   normalized observation
   screenshot
   diagnostics

2. Semantic execution
   platform-neutral actions
   semantic selector resolution
   action results
   execution recording
   explicit done signal

3. LLM provider boundary
   provider-neutral request and response types
   DeepSeek adapter
   explicit network smoke check

4. Scenario execution
   scenario representation
   instruction vs proof
   max-step handling
   deterministic runner

5. Verification
   deterministic assertions first
   structured proof evaluation
   evidence-based completion

6. Agent integration
   primary planning/navigation model
   restricted semantic tools

7. Narrow Jev judgments

8. Diagnosis and final classification

9. React Native/mobile environments
```

Do not skip ahead simply because a later feature is interesting.

The current local web runner now covers scenario execution, deterministic verification,
and restricted agent integration. Next work can build on evidence and diagnosis when
the current run statuses prove insufficient. The codebase may evolve as experience
reveals better boundaries. When a durable architectural decision changes, update this document.

## Definition of done for development work

Before declaring a development task complete:

1. Read the task requirements again.
2. Verify the requested behavior exists.
3. Run relevant type checking.
4. Run the smallest meaningful test/smoke surface for the change.
5. Inspect generated artifacts when they are part of the feature.
6. Fix failures discovered during verification.
7. Confirm the change does not violate the platform-neutral boundary.
8. Do not add unrelated cleanup merely to make the patch larger.
9. Update this document if a durable project rule or architecture decision changed.

A task is done only when the requested behavior has been implemented and meaningfully verified.
