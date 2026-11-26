import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { authorizeApi } from "@/lib/backend/auth/api-guard";
import type { AuthSettings } from "@/lib/backend/auth/identity";
/** One mandatory API boundary covers legacy routes as well as new job APIs. */
export async function proxy(request: Request) {
  const response =
    (await authorizeApi(env.DB, request, env as unknown as AuthSettings)) ??
    NextResponse.next();
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
export const config = { matcher: ["/api/:path*"] };
