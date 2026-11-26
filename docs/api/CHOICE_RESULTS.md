# Choice previews and result distributions

Task Definition choice blocks accept `answerAppearance: "checkbox-grid"` for
native multiple-choice checkboxes. Existing appearances remain supported.
Grounding accepts `groundingMode: "flexible"` with declared independent tiers;
`required` still controls answer necessity. An omitted optional batched block is
valid; supplied malformed values and missing required panels are rejected.

An administrator can explicitly configure a training choice block:

```json
{
  "id": "training-question",
  "type": "single_choice",
  "label": "Source question",
  "required": true,
  "trainingAnswerPreview": true,
  "showSourceAnswer": true,
  "sourceBindings": {
    "label": {"kind": "dataset", "fieldId": "question", "type": "string"},
    "options": {"kind": "dataset", "fieldId": "choices", "type": "string[]", "format": "array"},
    "preview": {"kind": "dataset", "fieldId": "reference_answer", "type": "json"}
  }
}
```

The ordinary authenticated draft/publish/create/launch APIs remain authoritative.
No client-provided preview value is accepted. Server capture deliberately pins
only the selected text choice value(s) in new training instances. A missing,
ambiguous or unsupported original prevents training-task creation. Ordinary
worker source-field responses continue to exclude private labels. This opt-in
is not an authorization bypass for the source-fields, results or export APIs.

Completed job results add `distributionVersion: "audiolab.distributions/1"` and
per-item `distribution: {counts:[{id,label,count}],ranks:[{id,label,positions}]}`.
Applicable choice items also add `reference: {origin:"current-source",available,
reason,observations:[{workerId,match}]}`; `match` is Boolean or null for
unavailable observations. Raw private reference payloads are not returned.
These administrator-only additions also appear in Research Export analytics.
See [metric definitions and denominators](../RESULTS.md).
