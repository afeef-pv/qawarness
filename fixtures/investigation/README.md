# Investigation benchmark

Run `bun run investigation:eval fixtures/investigation/manifest.json --trials 3 --json`
with the existing DeepSeek environment configuration. This makes live model calls
for both the preserved freeform baseline contract and the structured contract.
It never starts a browser or contacts the fixture application.

The 18 controlled cases are authored, sanitized normalized recordings of controlled
failure patterns, not production captures. They intentionally contain no images;
`missingFinalImage: true` declares this limitation. Add genuine recorded images
when testing visual attribution. An undeclared missing final image or any missing
referenced image fails the whole preflight before model calls. Fixture image paths
are relative to the case directory and may not escape it.

Labels are separate from provider input. Development cases may be used for tuning;
keep held-out cases untouched for comparison. Predeclare a target before tuning.
The current target is no new false product claims or unsupported causes, with
improved supported attribution on held-out cases. No improvement is established
yet. Three trials are not statistical significance.

Each evaluation saves immutable attempt JSON, read-only tool transcripts, and a
summary in `runs/investigation-evals/<uuid>/`. Compare only matching fingerprints.
Inspect each attempt against requiredClaim, supportingSteps, and unsupportedClaims;
record manual disagreements separately without changing model artifacts. Do not
score literal wording as causal correctness. Automatic classification counts do
not grade supporting claims. Unsupported explanations and claim-support scores
remain unavailable until humans review them. Usage and cost are unavailable when
not supplied; no monetary pricing assumptions are made. Failed reviews remain in
operational denominators. Repeated classifications and causes are listed for
manual agreement assessment, including failed trials.

To isolate the attribution rubric, run:

```sh
bun run investigation:eval fixtures/investigation/manifest.json --trials 3 --compare-attribution-rubric --json
```

This compares prior structured-v2 findings with structured-v3/rubric-v1 findings
using the same provider, evidence, 12-turn budget and 60-second time limit.
The `baseline` and `structured` aggregate labels identify those two arms.
Do not combine this mode with `--compare-reviewer`, `--max-turns`, or
`--max-duration-ms`. Existing output-contract and reviewer-setting comparisons
remain available separately.

Review the observed symptom, the proposed cause, and whether the cited evidence
actually distinguishes its alternative. Count an invented internal backend cause
as unsupported even when the product_failure classification is correct. Check
whether inconclusive findings name useful distinguishing evidence; do not reward
an attributed answer merely for avoiding abstention. Background-error and
ambiguous-click cases were added to the development split; the original held-out
cases remain unchanged. Keep human judgments in separate files keyed by attempt
path and fingerprint, never in model output or provider input.
