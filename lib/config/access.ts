/** Runtime-side configuration only. Do not import this module from cf's Node
 * config: this installed Vite plugin fails to load shared config/runtime modules
 * in its DEV Worker runner. Deployment has stricter preflight checks, paired in regression
 * tests; runtime authentication always validates the actual Worker bindings.
 */
export type AccessSettings = {
  AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  APP_ORIGIN?: string;
};

/** Validate operator-owned production settings before using any URL or token.
 * Exact origins also reject alternate Worker hostnames; forwarded headers never
 * select an issuer, JWKS endpoint or application origin.
 */
export function parseAccessConfiguration(settings: AccessSettings) {
  if (settings.AUTH_MODE && settings.AUTH_MODE !== "access")
    throw new Error("Production AUTH_MODE must be access.");
  const issuer = settings.ACCESS_TEAM_DOMAIN ?? "";
  const audience = settings.ACCESS_AUDIENCE ?? "";
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !audience ||
    audience.length > 512 ||
    /\s/.test(audience)
  )
    throw new Error(
      "Configure a valid Access issuer and application audience.",
    );
  let origin: URL;
  try {
    origin = new URL(settings.APP_ORIGIN ?? "");
  } catch {
    throw new Error("Configure the canonical HTTPS APP_ORIGIN.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== settings.APP_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw new Error("Configure the canonical HTTPS APP_ORIGIN without a path.");
  return { issuer, audience, origin: origin.origin };
}
