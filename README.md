# qawarness

Agentic QA harness.

Give it a scenario with an instruction and proof criteria.
An agent receives both and uses the app through a restricted semantic API.
When it believes the task is complete and the evidence supports the proof,
qawarness verifies the result separately.

```text
scenario
  ↓
agent
  ↓
QAEnvironment
  ↓
Playwright
  ↓
done
  ↓
verification
```

The agent does not write Playwright code.

The agent does not decide whether the test passed.

## Example

```yaml
fileType: qawarness/test/v1

name: sign-in

description: Verify that a user can sign in.

startUrl: http://localhost:3000/sign-in

instruction: |
  - Enter the test account credentials.
  - Sign in.
  - Stop once the authenticated application is reached.

proof:
  - type: url_contains
    value: /dashboard

  - type: text_visible
    text: Dashboard

  - type: judge
    text: The final application state clearly indicates that the user is authenticated.

maxSteps: 20
maxDuration: 90m
```

Save this example as `scenarios/sign-in.yaml`. Scenario files are local test inputs
and are ignored by Git.

Run it:

```bash
bun run qawarness validate scenarios/sign-in.yaml
bun run qawarness run scenarios/sign-in.yaml --headed
```

## CLI

```text
bun run qawarness --help
bun run qawarness run <scenario.yaml> [--headed]
bun run qawarness repeat <scenario.yaml> --count <1..20> --reset-url <url> --app-revision <revision> --fixture <id> [--headed]
bun run qawarness validate <scenario.yaml> [--json]
bun run qawarness runs list [--limit <1..100>] [--json]
bun run qawarness runs show <run-id> [--json]
```

Each command has `--help`. `validate` checks the scenario without a browser, model
key, or database. `runs` reads local completed reports from `runs/`; `--json` is
available for scripts. The `qa` and `qa:repeat` scripts remain aliases for `run`
and `repeat`.

Exit codes: 0 means validation succeeded or every run passed; 1 means a completed
run did not pass; 2 means invalid input or a setup error. Inspect the report's
result and diagnosis to see why a run did not pass.

## Proof

Use deterministic checks when possible.

```yaml
proof:
  - type: url_contains
    value: /dashboard

  - type: text_visible
    text: Dashboard
```

Use `judge` when the condition needs interpretation.

```yaml
proof:
  - type: judge
    text: The order summary correctly reflects the items purchased and the amount charged.
```

The execution agent sees all proof criteria alongside the instruction and app
observations. It uses them to decide when to call `done`. The verifier independently
checks the proof after `done`; failed verification ends the run without resuming
execution.
For `judge` proof, the reviewer receives the final screenshot, recent normalized
observations, and action history after `done`. The screenshot is sent to the
configured model provider. The run report records the screenshot path and step
numbers used as evidence; it does not embed image bytes.

Temporal checks can require an observed transition, rather than matching text that
was already present on the starting page:

```yaml
proof:
  - type: text_visible_after_click
    target: { by: role, role: button, name: Save }
    text: Saved
  - type: no_application_errors
```

`text_visible_after_click` requires the text to be absent before the matching click,
appear in a later recorded observation, and remain visible at verification. A failed
action and the `done` step each keep a screenshot beside their recorded observation.
The run also records execution, verification, and a separate evidence-backed diagnosis.
An unsatisfied proof is classified as `inconclusive` until the evidence establishes a
more specific cause.

## Repeat a scenario

The application must expose a `POST` reset endpoint on the same origin as `startUrl`.
Before each attempt, qawarness sends `{"fixture":"empty-store"}` as JSON. The endpoint
must finish restoring that fixture, then return 2xx JSON identifying the fixture and
the app revision it is serving:

```json
{"fixture":"empty-store","applicationRevision":"abc123"}
```

The response must match `--fixture` and `--app-revision`; otherwise the browser does
not start. The endpoint should report its own revision, rather than echoing a client
supplied revision.

```bash
bun run qawarness repeat scenarios/save.yaml \
  --count 5 \
  --reset-url http://localhost:3000/test/reset \
  --app-revision abc123 \
  --fixture empty-store
```

The command runs each attempt in a fresh browser, writes individual run artifacts,
and saves `runs/repeat-*.json` with the pass rate, average steps and duration, and
diagnosis counts. It also appends each reset and run transition to `runs/repeat-*.jsonl`,
so an interrupted batch shows which attempt was in progress. The JSON summary is
written only after every attempt completes. It refuses to combine runs whose scenario,
application revision, fixture, model, or environment context differs. For a single
`bun run qa`, optional `QA_APP_REVISION` and `QA_FIXTURE` values are recorded with the run.

Runs stop after at most 200 agent steps or 90 minutes. A scenario can request
lower limits with `maxSteps` and `maxDuration`.

`done` means:

> I think I finished.

It does not mean:

> PASS.

## Architecture

```text
Agent
├── LLMProvider
│   └── DeepSeekProvider
│
└── QAEnvironment
    └── PlaywrightEnvironment

Runner
└── RunStore
    └── MongoRunStore
```

MongoDB stores structured run history.

Large artifacts stay on disk.

```text
runs/<run-id>/
├── actions.jsonl
├── report.json
├── initial-observation.json
├── final-observation.json
├── final.png
├── steps/<sequence>-failed.png  # when an action fails
└── trace.zip
```

## Setup

```bash
bun install
bunx playwright install chromium
```

Configure:

```env
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=

MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=qawarness
```

Run checks:

```bash
bun run typecheck
bun run smoke
bun run action-smoke
bun run llm:smoke
```

Run QA:

```bash
bun run qawarness run scenarios/example.yaml
```

Watch it:

```bash
bun run qawarness run scenarios/example.yaml --headed
```

## Rules

- semantic actions over raw Playwright
- deterministic proof over LLM judgment when possible
- instruction and proof stay separate
- providers are replaceable
- execution backends are replaceable
- Mongo stores history
- files store evidence
- don't over-test
- don't over-engineer

Web first.

Mobile, visual QA, and deeper diagnosis later.

See `development.md`.
