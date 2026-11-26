import {
  parseAccessConfiguration,
  type AccessSettings,
} from "@/lib/config/access";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AuthSettings = AccessSettings;
export type AuthUser = {
  userId: string;
  displayName: string;
  mode: "access" | "demo";
};
export class AuthError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Convert pure configuration errors to sanitized HTTP availability errors.
 * Node configuration must not import this runtime module: it owns DEV predicates
 * and the JWT resolver used by the Worker, rather than Node's config loader.
 */
export function accessConfiguration(settings: AuthSettings) {
  try {
    return parseAccessConfiguration(settings);
  } catch (error) {
    throw new AuthError(
      503,
      error instanceof Error ? error.message : "Invalid Access configuration.",
    );
  }
}

/** Read only the supported bearer channels. Never accept query-string tokens. */
export function accessToken(request: Request) {
  return (
    request.headers.get("cf-access-jwt-assertion") ??
    (request.headers.get("cookie") ?? "").match(
      /(?:^|;\s*)CF_Authorization=([^;]+)/,
    )?.[1]
  );
}
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
/** Session tokens and limiter keys are stored only as SHA-256 digests. */
export async function digest(value: string) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
/** Local demo passwords only: production credentials are owned by Access/IdP. */
export async function demoPasswordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
      },
      key,
      256,
    ),
  );
}
export function demoAllowed(request: Request, settings: AuthSettings) {
  return (
    import.meta.env.DEV &&
    settings.AUTH_MODE === "demo" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  );
}
/** Check issuer, audience, signature, algorithm and lifetime. The production
 * resolver is pinned to the configured Access JWKS, never a token-supplied URL.
 * Tests may inject a local trusted key resolver; HTTP callers cannot.
 */
export async function verifyAccessToken(
  token: string,
  issuer: string,
  audience: string,
  key?: JWTVerifyGetKey,
) {
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience
  )
    throw new AuthError(503, "Access issuer/audience is not configured.");
  let trusted = key;
  if (!trusted) {
    if (!jwks.has(issuer))
      jwks.set(
        issuer,
        createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs")),
      );
    trusted = jwks.get(issuer)!;
  }
  const { payload } = await jwtVerify(token, trusted, {
    algorithms: ["RS256"],
    issuer,
    audience,
    requiredClaims: ["sub", "iss", "aud", "exp", "iat"],
    clockTolerance: 5,
    maxTokenAge: "24h",
  });
  // Service-token JWTs have an empty sub (common_name identifies the machine).
  // This release intentionally supports explicitly linked human identities only.
  if (
    payload.type !== "app" ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 256 ||
    payload.common_name !== undefined ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 24 * 60 * 60
  )
    throw new AuthError(401, "Invalid identity.");
  return payload.sub;
}
/** Resolve identity from verified Access claims or an expiring, revocable local
 * cookie. An existing fixture user is linked explicitly; email/name never grants
 * an account or admin role. Inactive accounts immediately lose access.
 */
export async function authenticate(
  db: D1Database,
  request: Request,
  settings: AuthSettings,
  verifier = verifyAccessToken,
): Promise<AuthUser> {
  let userId: string | undefined;
  const cookie = request.headers.get("cookie") ?? "";
  if (demoAllowed(request, settings)) {
    const token = cookie.match(
      /(?:^|;\s*)audiolab_demo=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    if (token)
      userId = (
        await db
          .prepare(
            "SELECT user_id AS id FROM auth_demo_sessions WHERE token_hash=? AND expires_at>?",
          )
          .bind(await digest(token), Date.now())
          .first<{ id: string }>()
      )?.id;
  } else {
    if (settings.AUTH_MODE === "demo")
      throw new AuthError(
        503,
        "Demo login is disabled outside loopback development.",
      );
    const { issuer, audience, origin } = accessConfiguration(settings);
    if (new URL(request.url).origin !== origin)
      throw new AuthError(
        503,
        "Configure the canonical HTTPS APP_ORIGIN before exposing AudioLab.",
      );
    const token = accessToken(request);
    if (!token) throw new AuthError(401, "Login required.");
    if (token.length > 16384) throw new AuthError(401, "Invalid login.");
    if (
      await db
        .prepare(
          "SELECT 1 FROM auth_access_revocations WHERE token_hash=? AND expires_at>?",
        )
        .bind(await digest(token), Date.now())
        .first()
    )
      throw new AuthError(401, "Login was revoked. Sign in again.");
    let subject: string;
    try {
      subject = await verifier(token, issuer, audience);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(401, "Invalid or expired login.");
    }
    userId = (
      await db
        .prepare(
          "SELECT user_id AS id FROM auth_identity_links WHERE issuer=? AND subject=?",
        )
        .bind(issuer, subject)
        .first<{ id: string }>()
    )?.id;
  }
  if (!userId)
    throw new AuthError(401, "Login required or identity not provisioned.");
  const account = await db
    .prepare(
      "SELECT display_name AS displayName FROM auth_accounts WHERE user_id=? AND active=1",
    )
    .bind(userId)
    .first<{ displayName: string }>();
  if (!account)
    throw new AuthError(403, "Account is inactive or not provisioned.");
  return {
    userId,
    displayName: account.displayName,
    mode: demoAllowed(request, settings) ? "demo" : "access",
  };
}
/** Browser writes require same-origin Origin. Production also pins the canonical
 * app origin; local scripted tests can omit Origin only on loopback in DEV.
 */
export function requireSameOrigin(request: Request, settings: AuthSettings) {
  const url = new URL(request.url),
    origin = request.headers.get("origin");
  if (settings.APP_ORIGIN && url.origin !== settings.APP_ORIGIN)
    throw new AuthError(403, "Unexpected application origin.");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin && origin !== url.origin) ||
    (!origin && !demoAllowed(request, settings))
  )
    throw new AuthError(403, "Same-origin request required.");
}
export async function projectRole(
  db: D1Database,
  project: string,
  user: string,
) {
  return (
    await db
      .prepare(
        "SELECT role FROM project_members WHERE project_id=? AND user_id=?",
      )
      .bind(project, user)
      .first<{ role: "admin" | "labeller" }>()
  )?.role;
}
export async function requireProjectAdmin(
  db: D1Database,
  project: string,
  user: string,
) {
  if ((await projectRole(db, project, user)) !== "admin")
    throw new AuthError(403, "Project admin permission required.");
}
