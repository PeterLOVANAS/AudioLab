import { env } from "cloudflare:workers";
import { createCandidateSetSchema } from "@/lib/backend/validation/candidate-sets";
import { candidateSetService, CandidateSetError } from "@/lib/backend/services/candidate-sets";

/**
 * POST an immutable candidate group from real stored source references.
 * The API proxy requires userId to match the verified session and project admin
 * membership; service checks retain exact source/task ownership.
 * Same request key/content retries return 200; conflicting replacements return 409.
 */
export async function POST(request: Request) {
  // The API proxy authenticates the session and enforces resource ownership.
let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ error: "Expected JSON body." }, { status: 400 }); }
  const parsed = createCandidateSetSchema.safeParse(body);
  if (!parsed.success)
    return Response.json({ error: "Invalid candidate set request.", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await candidateSetService.create(env.DB,parsed.data);
    return Response.json({ candidateSet: result.candidateSet }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof CandidateSetError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Candidate set creation failed",error);
    return Response.json({ error: "Unable to create candidate set." }, { status: 500 });
  }
}
