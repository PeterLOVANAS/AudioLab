import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  candidateSetService,
  CandidateSetError,
} from "@/lib/backend/services/candidate-sets";

/** Project-admin curation inventory, scoped to one published block and exact source item. */
export async function GET(request: Request) {
  // The API proxy authenticates the session and enforces resource ownership.
const parsed = z
    .object({
      projectId: z.uuid(),
      userId: z.string().trim().min(1).max(128),
      taskInstanceId: z.uuid(),
      blockId: z.string().min(1).max(80),
    })
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return Response.json(
      { error: "Invalid source inventory request." },
      { status: 400 },
    );
  try {
    const { projectId, userId, taskInstanceId, blockId } = parsed.data;
    return Response.json(
      await candidateSetService.inventory(
        env.DB,
        projectId,
        userId,
        taskInstanceId,
        blockId,
      ),
    );
  } catch (error) {
    if (error instanceof CandidateSetError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Candidate inventory failed", error);
    return Response.json(
      { error: "Unable to read candidate sources." },
      { status: 500 },
    );
  }
}
