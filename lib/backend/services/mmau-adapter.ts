import type { CanonicalImport } from "@/lib/backend/validation/dataset-ingestion";
/** Explicit legacy MMAU adapter. No inference in the generic importer/resolver.
 * The caller supplies the existing audio mapping. Original answer text must
 * match exactly one choice; ambiguous labels require an explicit adapter policy.
 */
export function adaptMmau(
  datasetId: string,
  sourceVersion: string,
  rows: Array<{
    id: string;
    audioId: string;
    question: string;
    instruction?: string;
    choices: string[];
    answer: string;
    annotation?: string;
  }>,
): CanonicalImport {
  return {
    schema_version: 1,
    dataset_id: datasetId,
    source_version: sourceVersion,
    provenance: { origin: "MMAU", revision: sourceVersion },
    records: rows.map((r) => {
      const choices = r.choices.map((label, i) => ({
        id: `choice-${i + 1}`,
        label,
      }));
      const matches = choices.filter((c) => c.label === r.answer);
      if (matches.length !== 1)
        throw new Error("MMAU answer must match exactly one choice");
      return {
        sample_id: r.id,
        audio_id: r.audioId,
        fields: {
          instruction: {
            type: "text",
            visibility: "worker",
            value: r.instruction ?? "Listen and answer",
          },
        },
        metadata: { original_answer: r.answer },
        items: [
          {
            item_id: "question",
            fields: {
              question: {
                type: "text",
                visibility: "worker",
                value: r.question,
              },
              choices: {
                type: "choices",
                visibility: "worker",
                value: choices,
              },
            },
            reference: { field: "choices", value: matches[0].id },
            annotations: r.annotation
              ? [{ field: "question", value: r.annotation }]
              : [],
          },
        ],
      };
    }),
  };
}
