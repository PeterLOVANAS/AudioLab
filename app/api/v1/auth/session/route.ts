import { env } from "cloudflare:workers";
import {
  authenticate,
  AuthError,
  demoAllowed,
  accessConfiguration,
  type AuthSettings,
} from "@/lib/backend/auth/identity";

/** A validated reauthentication link survives a later Access edge redirect or
 * failed session fetch. The UI must not replace expiry with a config-only screen.
 */
function loginLink(access?: ReturnType<typeof accessConfiguration>) {
  return access
    ? `${access.issuer}/cdn-cgi/access/login/${new URL(access.origin).hostname}?redirect_url=${encodeURIComponent(access.origin)}`
    : null;
}
/** Public session bootstrap returns no secrets; memberships determine navigation. */
export async function GET(request: Request) {
  const settings = env as unknown as AuthSettings;
  try {
    const user = await authenticate(env.DB, request, settings);
    // Display only the linked AudioLab account's name, never external IdP claims.
    // Older accounts may have a blank display name; keep the existing session
    // contract and use their local username without changing authentication.
    const displayName =
      user.displayName.trim() ||
      (
        await env.DB.prepare(
          "SELECT username FROM auth_accounts WHERE user_id=?",
        )
          .bind(user.userId)
          .first<{ username: string }>()
      )?.username ||
      "Account";
    const access =
      user.mode === "access" ? accessConfiguration(settings) : undefined;
    const memberships = (
      await env.DB.prepare(
        `SELECT m.project_id AS projectId,m.role,m.display_name AS displayName,p.name AS projectName
  FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=? ORDER BY p.name`,
      )
        .bind(user.userId)
        .all<{
          projectId: string;
          role: "admin" | "labeller";
          displayName: string;
          projectName: string;
        }>()
    ).results;
    return Response.json(
      {
        user: { ...user, displayName },
        memberships,
        mode: user.mode,
        configured: true,
        loginUrl: loginLink(access),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      let access: ReturnType<typeof accessConfiguration> | undefined;
      try {
        access = accessConfiguration(settings);
      } catch {
        /* Fail closed discovery; no unvalidated redirect. */
      }
      return Response.json(
        {
          user: null,
          memberships: [],
          mode: demoAllowed(request, settings) ? "demo" : "access",
          configured: demoAllowed(request, settings) || !!access,
          status: error.status,
          error: error.message,
          loginUrl: loginLink(access),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        user: null,
        error:
          "Authentication unavailable. Check configuration, bindings and applied identity migrations; do not reset existing data.",
      },
      { status: 503 },
    );
  }
}
