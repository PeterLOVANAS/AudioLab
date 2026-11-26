import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  demoAllowed,
  requireSameOrigin,
  digest,
  demoPasswordHash,
  AuthError,
  type AuthSettings,
} from "@/lib/backend/auth/identity";
/** A shared password is supported only for explicitly provisioned local demo
 * accounts. Production authentication must use Access; this endpoint is closed.
 */
export async function POST(request: Request) {
  const settings = env as unknown as AuthSettings;
  if (!demoAllowed(request, settings))
    return Response.json(
      { error: "Use the configured identity provider." },
      { status: 403 },
    );
  try {
    requireSameOrigin(request, settings);
    const raw = await request.text();
    if (raw.length > 4096)
      return Response.json({ error: "Invalid credentials" }, { status: 400 });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return Response.json({ error: "Invalid credentials" }, { status: 400 });
    }
    const p = z
      .strictObject({
        username: z.string().trim().min(1).max(128),
        password: z.string().min(8).max(256),
      })
      .safeParse(json);
    if (!p.success)
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    const window = Math.floor(Date.now() / 60000),
      key = await digest("demo-login:" + new URL(request.url).hostname);
    await env.DB.prepare(
      `INSERT INTO auth_login_limits(key,window_start,attempts) VALUES(?,?,1)
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start`,
    )
      .bind(key, window)
      .run();
    const limit = await env.DB.prepare(
      "SELECT attempts FROM auth_login_limits WHERE key=?",
    )
      .bind(key)
      .first<{ attempts: number }>();
    if ((limit?.attempts ?? 0) > 20)
      return Response.json(
        { error: "Too many attempts. Try again in a minute." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    const user = await env.DB.prepare(
      "SELECT user_id AS id,demo_salt AS salt,demo_password_hash AS hash FROM auth_accounts WHERE username=? AND active=1",
    )
      .bind(p.data.username)
      .first<{ id: string; salt: string | null; hash: string | null }>();
    // Always perform the same costly derivation; do not reveal account existence.
    const hash = await demoPasswordHash(
      p.data.password,
      user?.salt ?? "missing-account-dummy-salt",
    );
    let different = hash.length ^ (user?.hash?.length ?? 0);
    for (let i = 0; i < hash.length; i++)
      different |= hash.charCodeAt(i) ^ (user?.hash?.charCodeAt(i) ?? 0);
    if (!user?.salt || !user.hash || different !== 0)
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_demo_sessions WHERE expires_at<=?").bind(
        Date.now(),
      ),
      env.DB.prepare(
        "INSERT INTO auth_demo_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      ).bind(await digest(token), user.id, Date.now() + 8 * 60 * 60 * 1000),
    ]);
    return Response.json(
      { ok: true },
      {
        headers: {
          "set-cookie": `audiolab_demo=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Demo login failed");
    return Response.json(
      { error: "Login unavailable; check identity schema." },
      { status: 503 },
    );
  }
}
