import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  authenticate,
  AuthError,
  type AuthSettings,
} from "@/lib/backend/auth/identity";
import { researchOverview } from "@/lib/backend/services/research-overview";
/** Verified admin projects only. Context ID never grants cross-project access. */
export async function GET(request: Request) {
  try {
    const user = await authenticate(
      env.DB,
      request,
      env as unknown as AuthSettings,
    );
    const parsed = z
      .strictObject({ projectId: z.uuid() })
      .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
      throw new AuthError(400, "Valid project context required.");
    return Response.json(
      await researchOverview(env.DB, user.userId, parsed.data.projectId),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Research overview failed", error);
    return Response.json(
      { error: "Unable to load research statistics. Check server logs." },
      { status: 500 },
    );
  }
}
