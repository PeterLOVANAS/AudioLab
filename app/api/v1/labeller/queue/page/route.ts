/**
 * ADDITIVE optimized queue endpoint; leaves the legacy /labeller/queue intact.
 * Cursor/keyset pagination is O(page size) in returned rows, not an unbounded
 * 200-task response. JSON contains AUDIO URLs, never WAV bytes.
 *
 * SECURITY: The API proxy requires labellerId to equal the verified session
 * account and enforces project membership. Only that owner's assignments return.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { AssignmentSummary } from "@/lib/contracts/assignment-api";

type Cursor = { assignedAt: string; id: string };
function decodeCursor(raw: string): Cursor | null {
  try {
    const obj: unknown = JSON.parse(atob(raw));
    if (!obj || typeof obj !== "object") return null;
    const value = obj as Record<string, unknown>;
    if (
      typeof value.assignedAt !== "string" ||
      value.assignedAt.length > 64 ||
      typeof value.id !== "string" ||
      !z.uuid().safeParse(value.id).success
    )
      return null;
    return { assignedAt: value.assignedAt, id: value.id };
  } catch {
    return null;
  }
}
function encodeCursor(row: { assignedAt: string; id: string }): string {
  return btoa(JSON.stringify({ assignedAt: row.assignedAt, id: row.id }));
}

type DbRow = Omit<AssignmentSummary, "audioUrl">;
export async function GET(request: Request) {
  // The API proxy authenticates the session and enforces resource ownership.
const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId");
  const labellerId = params.get("labellerId")?.trim();
  const rawLimit = Number(params.get("limit") ?? "20");
  const rawCursor = params.get("cursor");
  if (
    !z.uuid().safeParse(projectId).success ||
    !labellerId ||
    labellerId.length > 128 ||
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    rawLimit > 50
  ) {
    return Response.json(
      { error: "Invalid projectId, labellerId or limit." },
      { status: 400 },
    );
  }
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor)
    return Response.json({ error: "Invalid queue cursor." }, { status: 400 });

  try {
    const member = await env.DB.prepare(
      `SELECT role FROM project_members WHERE project_id=? AND user_id=?`,
    )
      .bind(projectId, labellerId)
      .first<{ role: string }>();
    if (!member)
      return Response.json(
        { error: "Labeller not found in project." },
        { status: 404 },
      );
    if (member.role !== "labeller")
      return Response.json(
        { error: "Member is not a Labeller." },
        { status: 403 },
      );

    const rows = await env.DB.prepare(
      `
      SELECT a.id, a.project_id AS projectId, a.task_instance_id AS taskInstanceId,
        a.labeller_user_id AS labellerId, m.display_name AS labellerName,
        a.status, a.assigned_at AS assignedAt, a.started_at AS startedAt,
        i.asset_id AS assetId, asset.original_path AS originalPath,
        i.definition_id AS definitionId, i.definition_version AS definitionVersion,
        json_extract(v.definition_json, '$.name') AS definitionName
      FROM assignments a
      JOIN project_members m ON m.project_id=a.project_id AND m.user_id=a.labeller_user_id
      JOIN task_instances i ON i.id=a.task_instance_id
      JOIN audio_assets asset ON asset.id=i.asset_id
      JOIN task_definition_versions v ON v.definition_id=i.definition_id AND v.version=i.definition_version
      WHERE a.project_id=? AND a.labeller_user_id=?
        AND a.status IN ('assigned','in_progress')
        AND NOT EXISTS(SELECT 1 FROM annotation_job_assignments ja JOIN annotation_jobs j ON j.id=ja.job_id WHERE ja.assignment_id=a.id AND j.deleted_at IS NOT NULL)
        ${cursor ? "AND (a.assigned_at > ? OR (a.assigned_at = ? AND a.id > ?))" : ""}
      ORDER BY a.assigned_at ASC, a.id ASC
      LIMIT ?
    `,
    )
      .bind(
        ...(cursor
          ? [
              projectId,
              labellerId,
              cursor.assignedAt,
              cursor.assignedAt,
              cursor.id,
              rawLimit + 1,
            ]
          : [projectId, labellerId, rawLimit + 1]),
      )
      .all<DbRow>();
    const hasMore = rows.results.length > rawLimit;
    const selected = rows.results.slice(0, rawLimit);
    const assignments: AssignmentSummary[] = selected.map((row) => ({
      ...row,
      audioUrl: `/api/v1/assets/${row.assetId}/audio`,
    }));
    const last = assignments.at(-1);
    return Response.json({
      assignments,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    });
  } catch (error) {
    console.error("Paged labeller queue failed:", error);
    return Response.json(
      { error: "Unable to retrieve queue page." },
      { status: 500 },
    );
  }
}
