# Agent instructions

This repository is `qawarness`, a local agentic QA harness.

Before changing code for any development task, read `development.md`. It contains the architecture, boundaries, development philosophy, testing policy, and current project direction. Treat it as the source of truth for how code should be developed here.

## Development rules

- Use Bun as the runtime and package manager. Do not introduce Node-oriented runtime tooling such as `tsx` unless there is a concrete reason Bun cannot do the job.
- Keep the core platform-neutral. Playwright-specific concepts belong only in the Playwright adapter.
- Do not prematurely introduce LLMs, Jev, mobile backends, abstractions, plugins, or infrastructure before the current layer requires them.
- Prefer the smallest implementation that establishes the required architectural boundary.
- Do not over-test. Maintain a good test surface around meaningful behavior and architectural boundaries, but do not add tests for trivial implementation details or simply to increase coverage.
- Do not add presentational/browser tests whose only purpose is to pin styling, spacing, visual order, CSS, or markup structure.
- Before declaring a task complete, verify the behavior required by the task and run the relevant existing checks.
- `done` means execution believes a task is complete and ready for verification. It does not mean the QA scenario passed.
- When an architectural decision or durable development convention changes, update `development.md` as part of the same change.

## Working style

Read existing code before designing replacements.

Prefer clear code over speculative abstraction.

Do not redesign unrelated parts of the repository while completing a focused task.

When finishing a development task, report:

1. what materially changed,
2. important architectural decisions,
3. checks actually run,
4. whether they passed,
5. deliberate limitations or the next boundary.

Do not claim completion without verification.