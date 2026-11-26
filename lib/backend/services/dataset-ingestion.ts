import { ingestionSchema } from "@/lib/backend/validation/dataset-ingestion";
import { ingestionRepository } from "@/lib/backend/repositories/dataset-ingestion";
import { sourceFieldRepository } from "@/lib/backend/repositories/source-fields";
export class IngestionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Stable serialization makes property ordering irrelevant to idempotent reimports. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** Local admin service boundary; never mistake the supplied fixture ID for a session. */
export async function requireIngestionAdmin(
  db: D1Database,
  project: string,
  user: string,
) {
  if ((await sourceFieldRepository.role(db, project, user)) !== "admin")
    throw new IngestionError(403, "Project admin membership required");
}
/** Validate whole batch first. Dry run performs no writes; import is all-or-nothing. */
export async function ingestDataset(
  db: D1Database,
  project: string,
  user: string,
  raw: unknown,
  persist = false,
) {
  await requireIngestionAdmin(db, project, user);
  const parsed = ingestionSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      accepted: [],
      rejected: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  const data = parsed.data;
  const rejected: Array<{ path: string; message: string }> = [];
  const rows = [];
  // Preserve original TextGrid bytes as an immutable source artifact, while
  // validating that the public parsed text is exactly the same file/encoding.
  for (const [i, record] of data.records.entries()) {
    const scopes: Array<{
      fields: typeof record.fields;
      path: Array<string | number>;
    }> = [
      { fields: record.fields, path: ["records", i, "fields"] },
      ...record.items.map((item, j) => ({
        fields: item.fields,
        path: ["records", i, "items", j, "fields"],
      })),
    ];
    for (const scope of scopes)
      for (const [name, field] of Object.entries(scope.fields)) {
        if (field.type !== "textgrid" || !field.file) continue;
        const bytes = Uint8Array.from(atob(field.file.content_base64), (c) =>
          c.charCodeAt(0),
        );
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        let decoded: string;
        try {
          decoded = new TextDecoder(field.file.encoding, {
            fatal: true,
          }).decode(bytes);
        } catch {
          decoded = "";
        }
        if (hash !== field.file.sha256 || decoded !== field.value)
          rejected.push({
            path: [...scope.path, name, "file"].join("."),
            message:
              "TextGrid file checksum/encoding/content does not match its value",
          });
      }
  }
  if (rejected.length) return { ok: false, accepted: [], rejected };
  for (const [index, r] of data.records.entries()) {
    const audio = await db
      .prepare(
        "SELECT a.id FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id WHERE a.id=? AND d.id=? AND d.project_id=?",
      )
      .bind(r.audio_id, data.dataset_id, project)
      .first();
    if (!audio) {
      rejected.push({
        path: `records.${index}.audio_id`,
        message: "Existing audio not found in this project/dataset",
      });
      continue;
    }
    const previousSample = await db
      .prepare(
        `SELECT asset_id AS audio,canonical_json AS json FROM source_records
   WHERE canonical_dataset_id=? AND json_extract(canonical_json,'$.sample_id')=? AND json_extract(canonical_json,'$.source_version')=? LIMIT 1`,
      )
      .bind(data.dataset_id, r.sample_id, data.source_version)
      .first<{ audio: string; json: string }>();
    if (previousSample) {
      const old = JSON.parse(previousSample.json);
      if (
        previousSample.audio !== r.audio_id ||
        canonical(old.sample_fields) !== canonical(r.fields) ||
        canonical(old.metadata) !== canonical(r.metadata)
      ) {
        rejected.push({
          path: `records.${index}`,
          message:
            "Sample identity/content conflicts with existing source version",
        });
        continue;
      }
    }
    for (const [j, item] of r.items.entries()) {
      const record = JSON.stringify([
        r.sample_id,
        item.item_id,
        data.source_version,
      ]);
      const id = r.audio_id + "::" + record;
      const body = {
        schema_version: 1,
        sample_id: r.sample_id,
        item_id: item.item_id,
        source_version: data.source_version,
        provenance: data.provenance,
        sample_fields: r.fields,
        fields: item.fields,
        metadata: r.metadata,
      };
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              canonical({
                body,
                annotations: item.annotations,
                reference: item.reference ?? null,
              }),
            ),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const prior = await db
        .prepare(
          "SELECT ingestion_hash AS hash, asset_id AS audio FROM source_records WHERE (canonical_dataset_id=? AND source_record_id=?) OR (asset_id=? AND source_record_id=?)",
        )
        .bind(data.dataset_id, record, r.audio_id, record)
        .first<{ hash: string | null; audio: string }>();
      if (prior && (prior.hash !== hash || prior.audio !== r.audio_id))
        rejected.push({
          path: `records.${index}.items.${j}`,
          message:
            "Conflicting immutable source; use a new source_version and create new tasks",
        });
      rows.push({
        id,
        dataset: data.dataset_id,
        audio: r.audio_id,
        record,
        json: canonical(body),
        hash,
        annotations: item.annotations.length ? item.annotations : undefined,
        reference: item.reference,
        provenance: canonical(data.provenance),
      });
    }
  }
  if (rejected.length) return { ok: false, accepted: [], rejected };
  if (persist)
    try {
      await ingestionRepository.persist(db, rows);
    } catch (e) {
      if (
        String(e).includes("CANONICAL_") ||
        String(e).includes("canonical_item_identity")
      )
        throw new IngestionError(
          409,
          "Concurrent conflicting import; validate again",
        );
      throw e;
    }
  return {
    ok: true,
    persisted: persist,
    accepted: rows.map((r) => ({
      source_record_id: r.record,
      id: r.id,
      audio_id: r.audio,
    })),
    rejected: [],
  };
}
/** Admin inspection includes protected labels explicitly; ordinary workers use the public projector. */
export async function inspectImport(
  db: D1Database,
  project: string,
  user: string,
  dataset: string,
  record: string,
  audio: string,
) {
  await requireIngestionAdmin(db, project, user);
  const rows = await sourceFieldRepository.find(
    db,
    project,
    dataset,
    record,
    audio,
  );
  if (rows.length !== 1) throw new IngestionError(404, "Source item not found");
  return {
    item: rows[0].canonicalJson ? JSON.parse(rows[0].canonicalJson) : null,
    labels: await sourceFieldRepository.labels(db, rows[0].id),
  };
}
