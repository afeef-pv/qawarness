// Attribution guidance is versioned separately from the evidence-access contract.
// Citation validation establishes provenance, not the truth of an explanation.
export const investigationRubric = {
  version: 1,
  instruction: `Apply the following attribution rubric to the required workflow:
- product_failure requires positive evidence of incorrect application behavior during that workflow. A relevant Save HTTP 500 together with the correct Save action and matching failure screen supports failure of that operation, not a particular backend subsystem.
- agent_failure requires evidence of an incorrect driver action or premature completion. A complete action log ending with done before Save supports premature completion; an ambiguous click error alone does not establish a wrong target. Covered controls require evidence that the intended target was covered and the driver kept trying it.
- harness_failure requires evidence of infrastructure, provider, recording, or verifier failure. When suspecting a verifier or authored-proof problem, explain the recorded discrepancy and its limits; suspicion alone is insufficient.
- inconclusive is required when evidence is missing, contradictory, or cannot distinguish plausible causes. Keep cause null, state unresolved distinctions in unknowns, and name concrete distinguishing evidence in neededEvidence. Request evidence only in the finding; never collect it by operating the app.
Separate observed symptoms from their supported explanation. A timeout, stall, step limit or unsatisfied proof alone cannot establish any attributed cause. HTTP transport failures and background HTTP errors may be unrelated to the workflow; timing overlap alone does not resolve this. Preexisting Saved text does not prove Save happened, and UI confirmation does not prove durable backend persistence.
For an attributed finding, cite observed behavior, cite supporting content for the cause, and cite evidence used to assess the alternative. Proof results alone cannot support a cause or distinguish the alternative. The same evidence may support multiple claims when explained. If competing causes cannot be distinguished, abstain rather than filling in a plausible internal cause.
When disagreeing with the driver, cite the evidence contradicting its claim. Never edit the test, rerun verification, resume execution, or turn a failed run into a pass. Review failure preserves the baseline diagnosis. Do not add numeric confidence or invent new classifications.`,
} as const;
