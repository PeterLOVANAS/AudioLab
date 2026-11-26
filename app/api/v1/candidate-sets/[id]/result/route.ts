import { env } from "cloudflare:workers";
import { z } from "zod";
import { candidateResultService } from "@/lib/backend/services/candidate-results";
import { CandidateSetError } from "@/lib/backend/services/candidate-sets";

const actorSchema = z.strictObject({
  projectId: z.uuid(),
  userId: z.string().trim().min(1).max(128),
});
type Context = { params: Promise<{ id: string }> };
/** Admin-only aggregate preview or immutable finalization; never a blind-worker tally API. */
async function handle(request: Request, context: Context, finalize: boolean) {
  // The API proxy authenticates the session and enforces resource ownership.
const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const body: unknown = finalize
    ? await request.json().catch(() => null)
    : { projectId: params.get("projectId"), userId: params.get("userId") };
  const actor = actorSchema.safeParse(body);
  if (!z.uuid().safeParse(id).success || !actor.success)
    return Response.json({ error: "Invalid result request." }, { status: 400 });
  try {
    return Response.json({
      result: await candidateResultService.resolve(
        env.DB,
        actor.data.projectId,
        actor.data.userId,
        id,
        finalize,
      ),
    });
  } catch (error) {
    if (error instanceof CandidateSetError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Candidate result failed", error);
    return Response.json(
      { error: "Unable to resolve candidate votes." },
      { status: 500 },
    );
  }
}
export async function GET(request: Request, context: Context) {
  return handle(request, context, false);
}
export async function POST(request: Request, context: Context) {
  return handle(request, context, true);
}
