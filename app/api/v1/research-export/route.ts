import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  authenticate,
  AuthError,
  type AuthSettings,
} from "@/lib/backend/auth/identity";
import {
  buildResearchExport,
  audioExportFile,
} from "@/lib/backend/services/research-export";
import { zipStream, zipBytes, type ZipEntry } from "@/lib/backend/export/zip";
const query = z.strictObject({
  projectId: z.uuid(),
  jobId: z.uuid(),
  format: z
    .enum(["preview", "json", "audio-json", "json-zip", "audio-zip"])
    .default("preview"),
  audioId: z.uuid().optional(),
});
const encoder = new TextEncoder(),
  JSON_LIMIT = 32 * 1024 * 1024,
  ARCHIVE_LIMIT = 256 * 1024 * 1024;
/** Admin-only read/export. References and drafts are excluded at the service
 * projection, before serialization. Audio objects must belong to final-submitted
 * job tasks. Preflight all object sizes/existence before streaming ZIP headers.
 */
export async function GET(request: Request) {
  try {
    const user = await authenticate(
      env.DB,
      request,
      env as unknown as AuthSettings,
    );
    const parsed = query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new AuthError(400, "Invalid research export parameters.");
    const { projectId, jobId, format, audioId } = parsed.data;
    const data = await buildResearchExport(
      env.DB,
      user.userId,
      projectId,
      jobId,
    );
    let value: unknown = data;
    if (format === "audio-json") {
      const item = data.audioItems.find((item) => item.audioId === audioId);
      if (!item) throw new AuthError(404, "Audio is not part of this job.");
      value = audioExportFile(data, item);
    }
    const json = encoder.encode(JSON.stringify(value, null, 2));
    if (json.length > JSON_LIMIT)
      throw new AuthError(
        413,
        "Export JSON exceeds 32 MiB. Use a smaller job.",
      );
    if (format === "preview" || format === "json" || format === "audio-json")
      return new Response(json, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...(format !== "preview"
            ? {
                "content-disposition": `attachment; filename="${format === "audio-json" ? audioId : "audiolab-" + jobId}.json"`,
              }
            : {}),
        },
      });
    const annotated = data.audioItems.filter((item) =>
      item.taskReferences.some(
        (id) => data.tasks.find((task) => task.id === id)!.annotations.length,
      ),
    );
    if (!annotated.length)
      throw new AuthError(
        422,
        "No submitted annotations are available to export yet.",
      );
    const entries: ZipEntry[] = [zipBytes("job.json", json)];
    let total = json.length;
    for (const item of annotated) {
      if (!z.uuid().safeParse(item.audioId).success)
        throw new AuthError(422, "Asset has an invalid stable ID.");
      const metadata = encoder.encode(
        JSON.stringify(audioExportFile(data, item), null, 2),
      );
      total += metadata.length;
      entries.push(zipBytes(`annotations/${item.audioId}.json`, metadata));
      if (format === "audio-zip") {
        const asset = await env.DB.prepare(
          "SELECT a.storage_key AS key FROM audio_assets a JOIN datasets d ON d.id=a.dataset_id WHERE a.id=? AND d.project_id=? AND d.id=? AND a.storage_provider='r2'",
        )
          .bind(item.audioId, projectId, data.datasetId)
          .first<{ key: string }>();
        if (!asset)
          throw new AuthError(
            404,
            "Referenced audio asset is not available in this project/dataset.",
          );
        const object = await env.AUDIO_BUCKET.head(asset.key);
        if (!object)
          throw new AuthError(
            404,
            `Audio object missing for ${item.audioId}. No archive was started.`,
          );
        total += object.size;
        entries.push({
          name: `audio/${item.audioId}.wav`,
          size: object.size,
          async open() {
            const current = await env.AUDIO_BUCKET.get(asset.key);
            if (!current || current.etag !== object.etag)
              throw new Error(
                "Audio changed during export; retry the download.",
              );
            return current.body;
          },
        });
      }
      if (total > ARCHIVE_LIMIT)
        throw new AuthError(
          413,
          "Archive exceeds 256 MiB. Download JSON without audio or use a smaller job.",
        );
    }
    return new Response(zipStream(entries), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="audiolab-${jobId}-${format}.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Research export failed", error);
    return Response.json(
      { error: "Unable to prepare research export. Check the server log." },
      { status: 500 },
    );
  }
}
