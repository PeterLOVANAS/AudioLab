/**
 * DEV-ONLY curator API for candidate annotations. No source_labels SELECT!
 * GET /api/v1/annotation-candidates?assetId=<UUID>
 * POST {projectId,assetId,label,provenance}
 *
 * A reference answer is a benchmark secret. A curated candidate is a
 * hypothesis intentionally given to a labeller for verification. Confusing
 * these sources would contaminate MMAU evaluation and bias annotations.
 *
 * Replace the dev-only gate with authenticated researcher authorization
 * before deploying. The labeller should only receive the read response for
 * a task assigned to them (future real authorization requirement).
 */
import { env } from "cloudflare:workers";
import { z } from "zod";

const requestSchema = z.strictObject({
  projectId: z.uuid(),
  assetId: z.uuid(),
  label: z.string().trim().min(1).max(4000),
  provenance: z.enum(["researcher", "model", "early_annotation"]),
});
const denied = () =>
  import.meta.env.DEV
    ? null
    : Response.json(
        { error: "Not available without authentication" },
        { status: 403 },
      );
export async function GET(request: Request) {
  const notAllowed = denied();
  if (notAllowed) return notAllowed;
  const assetId = new URL(request.url).searchParams.get("assetId");
  if (!z.uuid().safeParse(assetId).success)
    return Response.json({ error: "Valid assetId required" }, { status: 400 });
  try {
    const rows = await env.DB.prepare(
      `SELECT id,asset_id AS assetId,label,provenance,created_at AS createdAt
      FROM annotation_candidates WHERE asset_id=? ORDER BY created_at,id LIMIT 100`,
    )
      .bind(assetId)
      .all();
    return Response.json({ candidates: rows.results });
  } catch (err) {
    console.error("GET candidates failed", err);
    return Response.json(
      { error: "Unable to load candidates" },
      { status: 500 },
    );
  }
}
export async function POST(request: Request) {
  const notAllowed = denied();
  if (notAllowed) return notAllowed;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const result = requestSchema.safeParse(raw);
  if (!result.success)
    return Response.json(
      { error: "Invalid candidate", issues: result.error.issues },
      { status: 400 },
    );
  const { projectId, assetId, label, provenance } = result.data;
  try {
    // A user-supplied projectId does not confer permission to insert a candidate
    // for another project's asset; verify the relationship in D1.
    const asset = await env.DB.prepare(
      `SELECT d.project_id AS projectId FROM audio_assets a
      JOIN datasets d ON d.id=a.dataset_id WHERE a.id=?`,
    )
      .bind(assetId)
      .first<{ projectId: string }>();
    if (!asset || asset.projectId !== projectId)
      return Response.json({ error: "Asset not in project" }, { status: 409 });
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO annotation_candidates(id,project_id,asset_id,label,provenance)
      VALUES (?,?,?,?,?)`,
    )
      .bind(id, projectId, assetId, label, provenance)
      .run();
    return Response.json(
      { candidate: { id, assetId, label, provenance } },
      { status: 201 },
    );
  } catch (err) {
    console.error("POST candidate failed", err);
    return Response.json(
      { error: "Unable to save candidate" },
      { status: 500 },
    );
  }
}
