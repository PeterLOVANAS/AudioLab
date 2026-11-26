import {
  SOURCE_FIELD_CATALOG,
  type SourceFieldPayload,
  type WorkerSourcePayload,
  type SourceFieldValue,
  type SourceFieldProvenance,
} from "@/lib/contracts/source-fields";
import { sourceFieldRepository, type SourceRow } from "@/lib/backend/repositories/source-fields";

/** HTTP viewer identity is verified by the mandatory API proxy; services also check persisted scope. */
export type SourceViewer = { projectId: string; userId: string; role: "admin" | "labeller" };
/** Admin sees original data; worker receives only public question/choices. */
export type SourceView = "admin" | "worker";

/** Invalid stored JSON is reported without including its potentially secret contents. */
export class SourceFieldDataError extends Error {}

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // JSON.parse errors can quote the input. Never log hidden labels via an
    // exception's message/cause, including for legacy rows bypassing ingestion.
    throw new SourceFieldDataError("Stored source field contains invalid JSON.");
  }
}

/**
 * Resolve T01 dataset fields and original annotations without copying their values.
 *
 * Checks persisted membership and exact project/dataset/(optional asset)/record
 * relationships before reading restricted labels. Returns null for denied,
 * missing or ambiguous sources, deliberately avoiding an existence oracle.
 * Missing/wrong-shaped question or variable-choice fields are omitted for the
 * binding caller to handle. Malformed JSON throws a sanitized SourceFieldDataError.
 * No writes occur; this reads the D1 binding supplied by the caller (local in
 * tests), not a remote endpoint. Returned timestamps are not frozen versions.
 */
export async function resolveSourceFields(
  db: D1Database,
  viewer: SourceViewer,
  datasetId: string,
  recordId: string,
  view: SourceView,
  assetId?: string,
): Promise<SourceFieldPayload | WorkerSourcePayload | null> {
  const role = await sourceFieldRepository.role(db, viewer.projectId, viewer.userId);
  if (
    role !== viewer.role ||
    (view === "admin" && role !== "admin") ||
    (view === "worker" && role !== "labeller")
  ) return null;

  const matches = await sourceFieldRepository.find(db, viewer.projectId, datasetId, recordId, assetId);
  if (matches.length !== 1) return null;
  const source = matches[0];
  const provenance: SourceFieldProvenance = {
    datasetId: source.datasetId,
    sourceRecordId: source.id,
    recordId: source.sourceRecordId,
    assetId: source.assetId,
    sourceUpdatedAt: source.updatedAt,
  };
  const publicSource = projectPublicSourceFields(source);
  if (view === "worker") return publicSource;
  const fields: SourceFieldValue[] = publicSource.fields.map((field) => ({ ...field, provenance }));

  for (const label of await sourceFieldRepository.labels(db, source.id)) {
    const descriptor = SOURCE_FIELD_CATALOG.find((field) => field.id === label.kind);
    if (!descriptor) continue;
    fields.push({
      field: descriptor,
      value: parseStoredJson(label.payloadJson),
      provenance: {
        ...provenance,
        labelId: label.id,
        labelProvenance: label.provenance,
        labelUpdatedAt: label.updatedAt,
      },
    });
  }
  fields.push({ field: SOURCE_FIELD_CATALOG[4], value: parseStoredJson(source.metadataJson), provenance });
  return {
    projectId: viewer.projectId,
    datasetId: source.datasetId,
    recordId: source.sourceRecordId,
    audio: { assetId: source.assetId, url: `/api/v1/assets/${source.assetId}/audio` },
    fields,
  };
}

/**
 * Reuse T01's worker allowlist after the caller has verified source scope.
 * Task creation uses this without inventing a labeller identity: the enclosing
 * service already checks project/dataset/asset relationships. This helper never
 * reads labels, parses arbitrary metadata or returns private source identity.
 */
export function projectPublicSourceFields(source: SourceRow): WorkerSourcePayload {
  const fields: WorkerSourcePayload["fields"] = [];
  if (source.canonicalJson) {
    const raw = parseStoredJson(source.canonicalJson) as {
      sample_fields: Record<string, unknown>;
      fields: Record<string, unknown>;
    };
    for (const [scope, values] of [
      ["sample", raw.sample_fields],
      ["item", raw.fields],
    ] as const)
      for (const [name, value] of Object.entries(values)) {
        const field = value as {
          type: string;
          visibility: string;
          value: unknown;
        };
        if (field.visibility !== "worker") continue;
        const type = field.type === "text" ? "string" : field.type;
        if (!["string", "number", "boolean", "choices", "textgrid"].includes(type))
          throw new SourceFieldDataError("Unsupported canonical field type");
        fields.push({
          field: {
            id: `${scope}.${name}`,
            type: type as import("@/lib/contracts/source-fields").SourceFieldType,
            visibility: "worker",
            provenance: "source_records",
          },
          value: field.value,
        });
      }
    return { audioUrl: `/api/v1/assets/${source.assetId}/audio`, fields };
  }
  if (typeof source.question === "string" && source.question.trim())
    fields.push({ field: SOURCE_FIELD_CATALOG[0], value: source.question });
  if (source.choicesJson !== null) {
    const choices = parseStoredJson(source.choicesJson);
    if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 50 &&
        choices.every((choice) => typeof choice === "string" && choice.trim()))
      fields.push({ field: SOURCE_FIELD_CATALOG[1], value: choices });
  }
  return { audioUrl: `/api/v1/assets/${source.assetId}/audio`, fields };
}
