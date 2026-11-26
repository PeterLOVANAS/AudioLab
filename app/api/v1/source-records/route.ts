/*
 * AudioLab 2.0 — Imported source records
 * POST /api/v1/source-records
 *
 * Development-only ingest endpoint. DO NOT serve source_labels in Labeller APIs.
 * Production must use authenticated Admin authorization.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { localDevelopmentOnly } from "@/lib/backend/http/local-development";

const Schema = z.strictObject({
  assetId: z.uuid(),
  sourceRecordId: z.string().min(1).max(200),
  sourceDomain: z.enum(["sound", "speech", "music", "unknown"]),
  question: z.string().min(1).max(10000).optional(),
  choices: z.array(z.string().max(2000)).min(2).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  labels: z
    .strictObject({
      referenceAnswer: z.unknown().optional(),
      earlyAnnotation: z.unknown().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  // Legacy mutable ingestion is local-only; canonical v1 is the release path.
  const denied = localDevelopmentOnly(request);
  if (denied) return denied;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 128 * 1024) {
    return Response.json(
      { error: "Source record too large." },
      { status: 413 },
    );
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return Response.json({ error: "Unable to read request." }, { status: 400 });
  }
  if (new TextEncoder().encode(raw).byteLength > 128 * 1024) {
    return Response.json(
      { error: "Source record too large." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid source record.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;
  try {
    const asset = await env.DB.prepare(
      "SELECT id FROM audio_assets WHERE id = ?",
    )
      .bind(input.assetId)
      .first<{ id: string }>();
    if (!asset)
      return Response.json(
        { error: "Audio asset not found." },
        { status: 404 },
      );

    // Stable identifier: rerunning the importer updates the same source record.
    // One asset may still have multiple distinct source questions/records.
    const sourceId = `${input.assetId}::${input.sourceRecordId}`;
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `
        INSERT INTO source_records
          (id, asset_id, source_record_id, source_domain, question, choices_json, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, source_record_id) DO UPDATE SET
          source_domain = excluded.source_domain,
          question = COALESCE(excluded.question, source_records.question),
          choices_json = COALESCE(excluded.choices_json, source_records.choices_json),
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
      `,
      ).bind(
        sourceId,
        input.assetId,
        input.sourceRecordId,
        input.sourceDomain,
        input.question ?? null,
        input.choices === undefined ? null : JSON.stringify(input.choices),
        JSON.stringify(input.metadata ?? {}),
      ),
    ];

    // Keep imported labels separate from annotation_revisions.
    // Never return these labels from the Labeller task DTO.
    const labels = input.labels;
    for (const [kind, field] of [
      ["reference_answer", "referenceAnswer"],
      ["early_annotation", "earlyAnnotation"],
    ] as const) {
      if (!labels || !Object.prototype.hasOwnProperty.call(labels, field))
        continue;
      const value = labels[field];
      if (value === undefined) continue;
      statements.push(
        env.DB.prepare(
          `
          INSERT INTO source_labels
            (id, source_record_id, kind, payload_json, provenance)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_record_id, kind) DO UPDATE SET
            payload_json = excluded.payload_json,
            provenance = excluded.provenance,
            updated_at = CURRENT_TIMESTAMP
        `,
        ).bind(
          `${sourceId}::${kind}`,
          sourceId,
          kind,
          JSON.stringify(value),
          kind === "reference_answer"
            ? "imported_source_answer"
            : "imported_early_annotation",
        ),
      );
    }

    // D1 batches are atomic: a failure rolls back the entire batch.
    await env.DB.batch(statements);
    return Response.json(
      { sourceRecordId: sourceId, assetId: input.assetId },
      { status: 200 },
    );
  } catch (error) {
    console.error("POST /api/v1/source-records failed:", error);

    const detail = error instanceof Error ? error.message : String(error);

    return Response.json(
      {
        error: "Unable to save source record.",
        detail: import.meta.env.DEV ? detail : undefined,
      },
      { status: 500 },
    );
  }
}

// GET /api/v1/source-records?assetId=<uuid>
// This selector endpoint has no verified viewer. Return question/choices only;
// metadata may embed ground truth. Restricted metadata uses /source-fields admin
// projection with persisted membership checks (and future session authorization).
export async function GET(request: Request) {
  // Admin asset scope is enforced by the mandatory API proxy.
  const assetId = new URL(request.url).searchParams.get("assetId");
  if (!z.uuid().safeParse(assetId).success) {
    return Response.json(
      { error: "A valid assetId is required." },
      { status: 400 },
    );
  }
  try {
    const result = await env.DB.prepare(
      `
      SELECT
        source_record_id AS sourceRecordId,
        source_domain AS sourceDomain,
        question,
        choices_json AS choicesJson
      FROM source_records
      WHERE asset_id = ?
      ORDER BY source_record_id
    `,
    )
      .bind(assetId)
      .all<{
        sourceRecordId: string;
        sourceDomain: string;
        question: string | null;
        choicesJson: string | null;
      }>();
    return Response.json({
      sourceRecords: result.results.map((row) => ({
        sourceRecordId: row.sourceRecordId,
        sourceDomain: row.sourceDomain,
        question: row.question,
        choices: row.choicesJson === null ? null : JSON.parse(row.choicesJson),
        // Preserve the legacy response shape without forwarding arbitrary JSON.
        metadata: {},
      })),
    });
  } catch (error) {
    console.error("POST /api/v1/source-records failed:", error);

    const detail = error instanceof Error ? error.message : String(error);

    return Response.json(
      {
        error: "Unable to save source record.",
        detail: import.meta.env.DEV ? detail : undefined,
      },
      { status: 500 },
    );
  }
}
