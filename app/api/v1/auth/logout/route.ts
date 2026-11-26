import { env } from "cloudflare:workers";
import {
  digest,
  authenticate,
  demoAllowed,
  requireSameOrigin,
  AuthError,
  type AuthSettings,
  accessToken,
} from "@/lib/backend/auth/identity";
/** Revoke this app session/token before redirecting to the identity provider logout. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request, env as unknown as AuthSettings);
    const settings = env as unknown as AuthSettings;
    if (!demoAllowed(request, settings)) {
      await authenticate(env.DB, request, settings);
      const access = accessToken(request);
      if (access)
        await env.DB.batch([
          env.DB.prepare(
            "DELETE FROM auth_access_revocations WHERE expires_at<=?",
          ).bind(Date.now()),
          env.DB.prepare(
            "INSERT INTO auth_access_revocations(token_hash,expires_at) VALUES(?,?) ON CONFLICT(token_hash) DO NOTHING",
          ).bind(await digest(access), Date.now() + 24 * 60 * 60 * 1000),
        ]);
    }
    const token = (request.headers.get("cookie") ?? "").match(
      /(?:^|;\s*)audiolab_demo=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    if (token)
      await env.DB.prepare("DELETE FROM auth_demo_sessions WHERE token_hash=?")
        .bind(await digest(token))
        .run();
    return Response.json(
      { ok: true, logoutUrl: "/cdn-cgi/access/logout" },
      {
        headers: {
          "set-cookie":
            `audiolab_demo=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Logout unavailable" }, { status: 503 });
  }
}
