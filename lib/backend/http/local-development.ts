/** Until C06/C07, this is isolation, not authentication. Do not expose a dev
 * server through a tunnel or bind it to a public network interface.
 */
export function localDevelopmentOnly(request: Request): Response | null {
  const url = new URL(request.url),
    origin = request.headers.get("origin");
  if (
    !import.meta.env.DEV ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (origin !== null && origin !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return Response.json(
      {
        error:
          "Loopback local development only; authentication is not configured.",
      },
      { status: 403 },
    );
  return null;
}
