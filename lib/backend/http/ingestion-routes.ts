import { env } from "cloudflare:workers";
import {
  ingestDataset,
  inspectImport,
  IngestionError,
} from "@/lib/backend/services/dataset-ingestion";
/** Canonical v1 routes share the authenticated project-admin API boundary. */
export async function ingestionRoute(
  request: Request,
  mode: "validate" | "import" | "inspect",
) {
  // The mandatory proxy verifies the authenticated actor and admin scope.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json(
      { error: "Cross-origin ingestion denied" },
      { status: 403 },
    );
  try {
    const q = new URL(request.url).searchParams;
    const project = q.get("projectId") ?? "",
      user = q.get("userId") ?? "";
    if (mode === "inspect")
      return Response.json(
        await inspectImport(
          env.DB,
          project,
          user,
          q.get("datasetId") ?? "",
          q.get("recordId") ?? "",
          q.get("audioId") ?? "",
        ),
      );
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 256 * 1024)
      return Response.json({ error: "Maximum 256 KiB" }, { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const result = await ingestDataset(
      env.DB,
      project,
      user,
      json,
      mode === "import",
    );
    return Response.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    if (e instanceof IngestionError)
      return Response.json({ error: e.message }, { status: e.status });
    console.error("Ingestion failed");
    return Response.json(
      { error: "Unable to ingest dataset" },
      { status: 500 },
    );
  }
}
