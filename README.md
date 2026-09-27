# qawarness

Agentic QA harness.

Give it a scenario.
An agent uses the app through a restricted semantic API.
When it thinks the task is done, qawarness verifies the result separately.

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
bun run qa scenarios/sign-in.yaml --headed
```

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

The execution agent never sees the proof.

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
├── final-observation.json
├── final.png
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
bun run qa scenarios/example.yaml
```

Watch it:

```bash
bun run qa scenarios/example.yaml --headed
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
