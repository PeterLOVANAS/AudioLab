import { env } from "cloudflare:workers";
import {
  authenticate,
  AuthError,
  requireProjectAdmin,
  type AuthSettings,
} from "@/lib/backend/auth/identity";
import { workerProfiles, teams } from "@/lib/backend/services/team-jobs";
import {
  workerProfileSchema,
  teamSchema,
} from "@/lib/backend/validation/team-jobs";
/** Filter/profile/team storage is admin-scoped and separate from account roles. */
export async function GET(request: Request) {
  try {
    const user = await authenticate(
        env.DB,
        request,
        env as unknown as AuthSettings,
      ),
      project = new URL(request.url).searchParams.get("projectId") ?? "";
    await requireProjectAdmin(env.DB, project, user.userId);
    return Response.json({
      workers: await workerProfiles(env.DB, project),
      teams: await teams(env.DB, project),
    });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request) {
  try {
    const user = await authenticate(
      env.DB,
      request,
      env as unknown as AuthSettings,
    );
    const body: unknown = await request.json();
    if (new URL(request.url).searchParams.get("action") === "team") {
      const p = teamSchema.parse(body);
      await requireProjectAdmin(env.DB, p.projectId, user.userId);
      const eligible = await workerProfiles(env.DB, p.projectId);
      if (
        p.memberIds.some(
          (id) =>
            !eligible.some(
              (w) => w.userId === id && w.active && w.accountReady,
            ),
        )
      )
        throw new AuthError(
          422,
          "Team members must be active project labellers.",
        );
      const id = p.teamId ?? crypto.randomUUID();
      if (
        p.teamId &&
        !(await env.DB.prepare(
          "SELECT id FROM worker_teams WHERE id=? AND project_id=?",
        )
          .bind(id, p.projectId)
          .first())
      )
        throw new AuthError(404, "Team not in this project.");
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO worker_teams(id,project_id,name,created_by) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
        ).bind(id, p.projectId, p.name, user.userId),
        env.DB.prepare(
          "DELETE FROM worker_team_members WHERE team_id=? AND project_id=?",
        ).bind(id, p.projectId),
        ...p.memberIds.map((member) =>
          env.DB.prepare(
            "INSERT INTO worker_team_members(team_id,project_id,user_id) VALUES(?,?,?)",
          ).bind(id, p.projectId, member),
        ),
      ]);
      return Response.json({ teamId:id,teams: await teams(env.DB, p.projectId) });
    }
    const p = workerProfileSchema.parse(body);
    await requireProjectAdmin(env.DB, p.projectId, user.userId);
    if (
      !(await workerProfiles(env.DB, p.projectId)).some(
        (w) => w.userId === p.userId,
      )
    )
      throw new AuthError(422, "Worker is not a project labeller.");
    await env.DB.prepare(
      `INSERT INTO worker_profiles(project_id,user_id,country,profession,languages_json,experience_years,active,metadata_json)
 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET country=excluded.country,profession=excluded.profession,languages_json=excluded.languages_json,experience_years=excluded.experience_years,active=excluded.active,metadata_json=excluded.metadata_json`,
    )
      .bind(
        p.projectId,
        p.userId,
        p.country,
        p.profession,
        JSON.stringify(p.languages),
        p.experienceYears,
        p.active ? 1 : 0,
        JSON.stringify(p.metadata),
      )
      .run();
    return Response.json({
      workers: await workerProfiles(env.DB, p.projectId),
    });
  } catch (error) {
    return fail(error);
  }
}
function fail(error: unknown) {
  if (error instanceof AuthError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error && typeof error === "object" && "issues" in error)
    return Response.json(
      { error: "Invalid profile/team fields", issues: error.issues },
      { status: 400 },
    );
  console.error("Worker profile update failed");
  return Response.json(
    {
      error: "Profile/team operation failed; check for a duplicate team name.",
    },
    { status: 409 },
  );
}
