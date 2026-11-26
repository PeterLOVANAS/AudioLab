/** Evaluate environment-specific bindings without contacting Cloudflare.
 * Local placeholders are never accepted as a deployed database. Cloud API tokens
 * belong to cf's operator environment, not Worker bindings or client bundles.
 */
export function deploymentEnvironment(
  values: Record<string, string | undefined>,
) {
  const target = values.AUDIOLAB_ENV ?? "local";
  if (!["local", "staging", "production"].includes(target))
    throw new Error("AUDIOLAB_ENV must be local, staging or production.");
  const hostMode = values.AUDIOLAB_HOST_MODE ?? "custom-domain";
  if (hostMode !== "custom-domain" && hostMode !== "workers-dev")
    throw new Error("AUDIOLAB_HOST_MODE must be custom-domain or workers-dev.");
  if (hostMode === "workers-dev" && target !== "staging")
    throw new Error("workers-dev hosting is supported only for staging.");
  const auth = {
    AUTH_MODE: values.AUDIOLAB_AUTH_MODE ?? "access",
    ACCESS_TEAM_DOMAIN: values.ACCESS_TEAM_DOMAIN ?? "",
    ACCESS_AUDIENCE: values.ACCESS_AUDIENCE ?? "",
    APP_ORIGIN: values.APP_ORIGIN ?? "",
  };
  if (target === "local") return { target, deployed: false as const, auth };
  // cf evaluates this module in Node before Vite starts. The installed CF Vite DEV runner fails
  // to load runtime modules that are also imported through this Node config. Keep this stricter deployment preflight self-contained;
  // the Worker independently validates configuration on every authenticated call.
  if (auth.AUTH_MODE !== "access")
    throw new Error("Production AUTH_MODE must be access.");
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      auth.ACCESS_TEAM_DOMAIN,
    ) ||
    !auth.ACCESS_AUDIENCE ||
    auth.ACCESS_AUDIENCE.length > 512 ||
    /\s/.test(auth.ACCESS_AUDIENCE)
  )
    throw new Error(
      "Configure a valid Access issuer and application audience.",
    );
  let origin: URL;
  try {
    origin = new URL(auth.APP_ORIGIN);
  } catch {
    throw new Error("Configure the canonical HTTPS APP_ORIGIN.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== auth.APP_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw new Error("Configure the canonical HTTPS APP_ORIGIN without a path.");
  function required(name: string, pattern: RegExp) {
    const value = values[name] ?? "";
    if (!pattern.test(value))
      throw new Error(`Configure ${name} for ${target}.`);
    return value;
  }
  const worker = required("AUDIOLAB_WORKER_NAME", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const database = required(
    "AUDIOLAB_D1_ID",
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
  if (database === "11111111-1111-4111-8111-111111111111")
    throw new Error(
      "A deployed environment requires its real D1 ID, not the local placeholder.",
    );
  const databaseName = required(
    "AUDIOLAB_D1_NAME",
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/,
  );
  const bucket = required(
    "AUDIOLAB_R2_BUCKET",
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
  );
  if (
    origin.port ||
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new Error(
      "Use a canonical HTTPS hostname without a port for deployment.",
    );
  if (hostMode === "workers-dev") {
    const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    const subdomain = required("AUDIOLAB_WORKERS_SUBDOMAIN", dnsLabel);
    if (
      !dnsLabel.test(worker) ||
      origin.origin !== `https://${worker}.${subdomain}.workers.dev`
    )
      throw new Error(
        "APP_ORIGIN must exactly match the staging Worker name and AUDIOLAB_WORKERS_SUBDOMAIN.",
      );
    // This is an operator deployment gate, NOT proof of an external Access policy.
    // Create an empty/unseeded Worker and verify its All traffic policy before
    // confirming. JWT/role checks remain authoritative for every protected API.
    if (values.AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED !== "true")
      throw new Error(
        "Verify Worker-level Access All traffic before setting AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED=true. Cloud protection cannot be verified offline.",
      );
  } else {
    if (
      origin.hostname === "workers.dev" ||
      origin.hostname.endsWith(".workers.dev")
    )
      throw new Error(
        "workers.dev requires the explicit staging-only workers-dev host mode.",
      );
    if (
      values.AUDIOLAB_WORKERS_SUBDOMAIN ||
      values.AUDIOLAB_WORKERS_DEV_ACCESS_CONFIRMED
    )
      throw new Error(
        "Remove workers-dev settings when using custom-domain mode.",
      );
  }
  return {
    target,
    deployed: true as const,
    auth,
    worker,
    database,
    databaseName,
    bucket,
    hostname: origin.hostname,
    hostMode,
    workersDev: hostMode === "workers-dev",
  };
}
