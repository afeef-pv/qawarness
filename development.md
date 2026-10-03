# Development

This file owns durable engineering decisions for `qawarness`. Exact action schemas,
scenario fields, CLI flags, limits, and persistence shapes belong in code and tests.
Update this file when an architectural boundary or development rule changes.

## Purpose and boundaries

`qawarness` is a local agentic QA harness. Web is the first target; mobile backends
may be added without replacing the agent, scenario, recording, or verification core.

- The agent depends on the provider-neutral `LLMProvider` and platform-neutral
  `QAEnvironment` contracts. DeepSeek and Playwright are adapters.
- Keep `Page`, `Locator`, browser contexts, Playwright selectors, and arbitrary
  browser code inside the Playwright adapter. Core actions and targets remain
  semantic and restricted. Prefer role and accessible name, then label, text,
  test ID, CSS, and finally coordinates.
- Use Bun for runtime and package management, TypeScript for source, and Chromium
  for the initial web backend. Do not add another TypeScript runtime or a new
  dependency without a concrete need.
- Keep credentials in environment configuration. Network smoke checks are
  explicit because they depend on external services.

## Execution

Backends return normalized observations with useful location, text, elements,
screenshots, and errors. Use platform accessibility information where available;
do not serialize the whole DOM or build a second accessibility system.

The web agent receives the current viewport screenshot and normalized observation.
The screenshot decides which controls are on top when DOM text also includes
covered controls. Only the latest image is sent with each model request; text
history remains. Agent screenshots stay in the run directory.

The loop is observe → one validated semantic action → observe. Ordinary action
failures return to the agent for recovery; an unavailable environment stops the
run after recording the failure. The agent can wait briefly for transitions.
When a successful click has no immediate visible effect, an identical requested
click is deferred into a recorded wait and fresh observation. A bounded guard
stops repeated requests before the click can be replayed indefinitely. Repeated
actions without visible progress and scenario duration or step limits also stop
execution. Effective limits are recorded with each run.

Scenarios keep the instruction and proof separate. The agent sees both so it knows
what success requires; the verifier independently decides whether the proof holds.
Validate scenarios before starting the browser or provider. The CLI connects to
an externally started app server.

The Bun CLI is the operator entry point for defining, running, repeating,
validating, and inspecting local reports. Keep parsing and help at that edge,
reuse the same run functions as the legacy package aliases, and preserve exit
codes: 0 for success, 1 for a completed non-passing run, 2 for invalid input or
setup error. Scenario files remain the authored test definitions; the CLI does
not create a second definition store. Plain-text definitions are explicit
name, description, start URL, instruction, and proof fields. Save each wording
as an immutable YAML version; omitted fields on a revision carry forward.
Plain-text proof maps to the existing independent judge proof without calling
a model while defining it. Prefer handwritten deterministic proof where possible.

`done` means the agent believes the task is ready for verification. It is an
execution record, not a browser action or a pass. Proof is checked once after
`done`; failed verification ends the run. Do not resume execution to repair a
failed proof.

## Verification and diagnosis

Prefer deterministic proof. Use a model judgment for criteria that cannot be
expressed reliably with deterministic checks. A visual judgment starts with the
final screenshot and bounded action and observation history through `LLMProvider`.
It can page through recorded actions and observation text, list screenshot IDs,
and retrieve earlier screenshots through read-only evidence tools. The model
never selects filesystem paths or receives an environment or shell. Only the
latest requested image is sent per turn. Record inspected evidence and review
tool transcripts without image bytes. Bound review turns; proof review shares
the scenario deadline.
Only a satisfied judgment passes; missing visual evidence cannot pass. Keep
screenshots as files and store references, not image bytes, in MongoDB.

Temporal proof must use recorded history, not only the final screen. For example,
text that existed before a click does not prove it appeared afterward, and an
error cleared by navigation still counts for a no-error proof.

Keep execution status, proof results, and diagnosis separate. Diagnosis uses
`passed`, `product_failure`, `agent_failure`, `harness_failure`, or `inconclusive`,
with a reason and evidence references. A failed proof alone is inconclusive; do
not claim a product defect without evidence. `done` never implies a pass.

After the environment closes, investigate otherwise inconclusive failures with
recorded steps using the same read-only evidence tools. This separate, bounded
model review may refine diagnosis, but cannot change execution status or proof
results, resume the app, or declare a failed run passed. Preserve the baseline
diagnosis if investigation fails, and record that failure separately. Skip
automatic investigation when the scenario duration is exhausted or the cause is
already established. Keep the runner heartbeat alive through investigation and
final persistence. The CLI can investigate a completed local failure later;
write each such review as a separate artifact without rewriting the original
report or MongoDB history. Investigation completion is not a QA pass.

Completed failure investigations add a versioned primary finding, separating
expected behavior, observation, cause, alternatives, and unknowns. Claim citations
must name content actually supplied or successfully retrieved: action records,
viewed screenshot IDs, retrieved diagnostic IDs, returned observation text ranges, or summary proof/error
indexes. The broad access ledger remains separate. Invalid findings fail review
and preserve the baseline; provenance does not establish causal truth.

Failure investigation starts with a bounded, deterministic event index of recorded
actions, outcomes, times, URL changes, newly recorded application errors, failed
proof indexes, and screenshot IDs with their original timing. These entries are
retrieval starting points, not causes or access to full records. Review compares
surrounding states and a plausible alternative; missing distinguishing evidence
remains explicit. Legacy benchmark review keeps its previous input contract.
Imported histories beyond the normal step cap disclose omitted index events;
the original read-only paging tools still expose the complete recording.

The explicit `investigation:eval` Bun command reviews checked-in portable fixtures
without starting an app or browser. Labels and previous reviews are excluded;
baseline diagnosis is recomputed. It compares the legacy and structured output
contracts on identical fingerprinted evidence, saving unique attempts outside
normal run history. Missing declared artifacts fail preflight; intentionally
absent final images must be declared. Classification counts are automatic, while
claim support and unsupported causes require human transcript review. Unknown
usage and monetary cost are unavailable, never zero. The initial controlled
text-only suite is a mechanics and attribution starting point, not evidence of
real-world or visual accuracy.

Jev and mobile execution remain future extensions. Do not add them or broader
model autonomy before a current requirement needs them.

## Evidence and history

Record actions, outcomes, timing, normalized observations, and relevant errors
outside the platform adapter. Append JSONL so earlier steps survive a crash.
Associate each execution step with the screenshot supplied to the agent before
its action. Capture screenshots after failed actions and `done`; retain the Playwright trace as
detailed fallback evidence. Mask standard password inputs. Images can still
contain private app data, so keep them as local run artifacts.
Legacy observation screenshot references may precede their action; expose that
timing uncertainty instead of relabeling them as screenshots after the action.

MongoDB stores structured run history behind `RunStore`; the filesystem stores
screenshots, traces, JSONL, and portable reports. Scenario definitions are
versioned by normalized content and runs retain a snapshot. Write steps as they
finish. A running record without a final status may indicate interruption. A
failed initial database write prevents execution; later write failures surface
after filesystem evidence and finalization are attempted.

Capture run context when available: app and harness revisions, fixture, model
settings, browser version, and viewport. Repeat runs require an explicit
same-origin reset endpoint and named fixture. Before each attempt, send the fixture
identity and require the reset response to confirm the restored fixture and actual app
revision. Compare only runs with matching scenario content and context; the CLI does
not own the application server. Append repeat-group progress as JSONL so interrupted
batches retain their attempt history; write the aggregate summary only after all
attempts finish.

The localhost dashboard reads persisted history and allowlisted run artifacts.
It does not control the runner or rewrite run records. Poll active runs through
finalization; show overdue unfinished runs as interrupted without inventing an
end time or diagnosis. Keep dashboard tests about behavior, not presentation.

## Development practice

- Prefer concrete requirements and the smallest code that meets them. The
  platform boundary is intentional; other abstractions must earn their place.
- Keep related behavior together. Use domain names. Avoid tiny single-use
  helpers when inline code is clearer.
- Validate at real boundaries once. Trust internal contracts and handle real
  failures without elaborate paths for impossible states.
- Add tests for meaningful behavior, architectural boundaries, failure handling,
  recording, and verification. Do not chase coverage or test trivial structure,
  style, markup order, or speculative backends.
- Before declaring work done, verify the requested behavior, run relevant
  typechecks and the smallest meaningful tests or smoke checks, and inspect
  produced artifacts when they matter. Fix failures and update this file if a
  durable decision changed.

## Diagnostic evidence and investigation configuration

Optional version-1 application diagnostics supplement observation errors. HTTP
responses >=400 do not participate in existing no-error proofs; transport,
console and page errors retain their existing error behavior. Diagnostics retain
run-local event/request IDs, occurrence and request-start times across navigation
and repeated observations. The adapter removes URL credentials, query strings
and fragments and records no headers or bodies. Screenshot observations include
actual capture completion timestamps. Event/action interval overlap is a timing
relationship, never causal attribution. Read-only diagnostic paging grants citation
access independently of the timeline; legacy absence means unavailable evidence.

Failure investigation alone accepts an independently composed provider. Execution
and judge proof keep their original provider. Operator environment overrides are
`QA_REVIEWER_MODEL`, `QA_REVIEWER_REASONING` (none/low/high/max),
`QA_REVIEWER_TEMPERATURE`, and `QA_REVIEWER_MAX_TOKENS`; credentials and endpoint
reuse DeepSeek configuration. Defaults retain non-thinking tool review. Thinking
uses automatic tool choice and opaque adapter continuation replay; continuation
is kept only in memory, not transcripts. Effective sampling records null when
thinking ignores temperature. Each attempt records role, original run, requested
and returned models, settings, prompt/evidence hashes, budgets, calls and available
usage. Unknown cost remains null. Budget exhaustion fails review and preserves
the baseline.

`investigation:eval ... --compare-reviewer` compares default and overridden reviewer
settings with the same structured contract and identical recordings. Optional
`--max-turns` and `--max-duration-ms` change only the comparison budget. Without
that flag the legacy-versus-structured contract comparison remains available.
Change one setting at a time to isolate effects; classification metrics do not
establish citation support, which still requires human review. Live comparisons
are explicit and no improvement is asserted from fake-provider tests.

## Attribution and uncertainty

Failure investigation uses attribution rubric v1. Product findings require positive
incorrect application behavior in the required workflow; agent findings require an
incorrect action or premature completion; harness findings require infrastructure,
provider, recording or verifier evidence. Missing, contradictory or indistinguishable
evidence remains inconclusive. Symptoms, temporal proximity and proof failure do
not establish an internal cause. UI confirmation alone does not establish persistence.

New structured investigations use finding contract version 2 with the existing
fields. Attributed findings must separately cite observed behavior, cause support
beyond proof results, and content assessing a plausible alternative. Inconclusive
findings keep cause null, explain unknowns and identify distinguishing needed
evidence. These requirements enforce provenance and a reviewable explanation,
not causal truth. Invalid findings fail review and preserve baseline diagnosis;
no correction or new execution is attempted. Existing version-1 reports remain
readable and immutable. Attempt metadata records rubric and prompt versions;
review transcripts include the system instructions for human inspection.

`investigation:eval ... --compare-attribution-rubric` compares the prior structured
contract and the rubric on identical recordings with the same provider and budgets.
It cannot combine reviewer-setting or budget changes. Automatic metrics count
classification and false product claims; support and unsupported internal causes
still require separate human review. Background HTTP errors and ambiguous clicks
have controlled development cases; no real-model accuracy improvement is claimed
from scripted contract tests.
