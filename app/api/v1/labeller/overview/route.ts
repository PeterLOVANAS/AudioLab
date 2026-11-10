/**
 * Local-development Labeller overview.
 * Aggregate counts in D1, not by downloading a 200-row queue to the browser.
 * No WAV bytes, reference labels, or other labellers' answers are returned.
 *
 * SECURITY: caller-supplied labellerId is not authentication. This endpoint is
 * disabled outside dev until server sessions and authorization are integrated.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";

type Counts = {
  total: number;
  assigned: number;
  inProgress: number;
  submitted: number;
  reviewed: number;
  drafts: number;
};
type Recent = {
  id: string;
  definitionName: string;
  status: string;
  assignedAt: string;
  submittedAt: string | null;
};

export async function GET(request: Request) {
  if (!import.meta.env.DEV) {
    return Response.json(
      { error: "Authentication is not configured." },
      { status: 403 },
    );
  }
  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId");
  const labellerId = params.get("labellerId")?.trim();
  if (
    !z.uuid().safeParse(projectId).success ||
    !labellerId ||
    labellerId.length > 128
  ) {
    return Response.json(
      { error: "Valid project and labeller IDs required." },
      { status: 400 },
    );
  }
  try {
    const member = await env.DB.prepare(
      "SELECT role FROM project_members WHERE project_id=? AND user_id=?",
    )
      .bind(projectId, labellerId)
      .first<{ role: string }>();
    if (!member)
      return Response.json({ error: "Labeller not found." }, { status: 404 });
    if (member.role !== "labeller")
      return Response.json({ error: "Not a Labeller." }, { status: 403 });

    // Use conditional aggregation: one D1 scan for every status total.
    // The composite idx_assignments_labeller_queue supports this scope.
    const result = await env.DB.prepare(
      `
      SELECT COUNT(*) AS total,
        COALESCE(SUM(status='assigned'),0) AS assigned,
        COALESCE(SUM(status='in_progress'),0) AS inProgress,
        COALESCE(SUM(status='submitted'),0) AS submitted,
        COALESCE(SUM(status='reviewed'),0) AS reviewed
      FROM assignments WHERE project_id=? AND labeller_user_id=?
    `,
    )
      .bind(projectId, labellerId)
      .first<Omit<Counts, "drafts">>();
    const draftRow = await env.DB.prepare(
      `
      SELECT COUNT(DISTINCT a.id) AS drafts
      FROM assignments a
      JOIN annotation_revisions r ON r.assignment_id=a.id
      WHERE a.project_id=? AND a.labeller_user_id=?
        AND a.status='in_progress' AND r.status='draft'
    `,
    )
      .bind(projectId, labellerId)
      .first<{ drafts: number }>();

    // Recent rows allow opening submitted work READ-ONLY through the workspace.
    const recent = await env.DB.prepare(
      `
      SELECT a.id,
        COALESCE(json_extract(v.definition_json,'$.name'),'Untitled task') AS definitionName,
        a.status, a.assigned_at AS assignedAt, a.submitted_at AS submittedAt
      FROM assignments a
      JOIN task_instances i ON i.id=a.task_instance_id
      JOIN task_definition_versions v ON v.definition_id=i.definition_id
        AND v.version=i.definition_version
      WHERE a.project_id=? AND a.labeller_user_id=?
      ORDER BY a.assigned_at DESC, a.id DESC LIMIT 8
    `,
    )
      .bind(projectId, labellerId)
      .all<Recent>();
    const counts: Counts = {
      total: result?.total ?? 0,
      assigned: result?.assigned ?? 0,
      inProgress: result?.inProgress ?? 0,
      submitted: result?.submitted ?? 0,
      reviewed: result?.reviewed ?? 0,
      drafts: draftRow?.drafts ?? 0,
    };
    return Response.json({ counts, recent: recent.results });
  } catch (error) {
    console.error("Labeller overview failed:", error);
    return Response.json(
      { error: "Unable to retrieve Labeller overview." },
      { status: 500 },
    );
  }
}
