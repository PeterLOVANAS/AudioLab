import { env } from "cloudflare:workers";
import { z } from "zod";
import { resolveSourceFields } from "@/lib/backend/services/source-fields";

const requestSchema = z.object({
  projectId: z.uuid(),
  datasetId: z.uuid(),
  userId: z.string().trim().min(1).max(128),
  recordId: z.string().min(1).max(200),
  view: z.enum(["admin", "worker"]),
  assetId: z.uuid().optional(),
});

/**
 * GET /api/v1/source-fields: scoped imported values for authoring previews.
 *
 * Optional assetId disambiguates external IDs repeated across recordings. Missing
 * or inaccessible records return the same 404. Worker output excludes originals
 * and metadata on the server. The API proxy verifies userId against the session
 * and authorizes admin previews; assigned workers use pinned task snapshots.
 */
export async function GET(request: Request) {
  // The API proxy authenticates the session and enforces resource ownership.
  const params = new URL(request.url).searchParams;
  const parsed = requestSchema.safeParse({
    projectId: params.get("projectId"),
    datasetId: params.get("datasetId"),
    userId: params.get("userId"),
    recordId: params.get("recordId"),
    view: params.get("view"),
    assetId: params.get("assetId") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "Invalid source request." }, { status: 400 });
  }
  const { projectId, datasetId, userId, recordId, view, assetId } = parsed.data;
  try {
    const payload = await resolveSourceFields(
      env.DB,
      { projectId, userId, role: view === "admin" ? "admin" : "labeller" },
      datasetId, recordId, view, assetId,
    );
    return payload
      ? Response.json({ source: payload })
      : Response.json({ error: "Source unavailable." }, { status: 404 });
  } catch (error) {
    console.error("Source field read failed:", error);
    if (/no such (column|table)/i.test(String(error))) return Response.json({code:"LOCAL_SCHEMA_MIGRATION_REQUIRED",error:"Local D1 schema is behind this application. Back up and apply the reviewed local migrations before loading dataset content or assignments."},{status:503});
    return Response.json({ error: "Unable to read source." }, { status: 500 });
  }
}
