import { env } from "cloudflare:workers";
import { z } from "zod";
import {
  allocationSchema,
  confirmAllocationSchema,
} from "@/lib/backend/validation/assignment-allocation";
import {
  allocationItems,
  previewAllocation,
  confirmAllocation,
  AllocationError,
} from "@/lib/backend/services/assignment-allocation";

function failure(error: unknown) {
  if (error instanceof AllocationError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error("Local assignment allocation failed", error);
  return Response.json(
    {
      error:
        "Allocation failed. Check local schema and server logs; no assignment success is assumed. Retry the same preview safely.",
    },
    { status: 500 },
  );
}
/** Admin item selection is paginated and exposes source identity, never labels. */
export async function GET(request: Request) {
  // Verified actor, project and dataset scope are enforced by proxy.ts.
  const parsed = z
    .strictObject({
      projectId: z.uuid(),
      adminId: z.string().min(1).max(128),
      datasetId: z.uuid(),
      cursor: z.string().max(1000).optional(),
    })
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return Response.json(
      { error: "Invalid item selector parameters" },
      { status: 400 },
    );
  try {
    const p = parsed.data;
    return Response.json(
      await allocationItems(
        env.DB,
        p.projectId,
        p.adminId,
        p.datasetId,
        p.cursor,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
/** Preview is read-only. Confirmation accepts only explicit reviewed identity pairs. */
export async function POST(request: Request) {
  // Verified actor, project and dataset scope are enforced by proxy.ts.
  const action = new URL(request.url).searchParams.get("action");
  if (!["preview", "confirm"].includes(action ?? ""))
    return Response.json(
      { error: "Choose preview or confirm" },
      { status: 400 },
    );
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return Response.json({ error: "Cannot read request" }, { status: 400 });
  }
  if (new TextEncoder().encode(raw).length > 128 * 1024)
    return Response.json(
      { error: "Maximum request size is 128 KiB" },
      { status: 413 },
    );
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed =
    action === "preview"
      ? allocationSchema.safeParse(body)
      : confirmAllocationSchema.safeParse(body);
  if (!parsed.success)
    return Response.json(
      { error: "Invalid allocation selection", issues: parsed.error.issues },
      { status: 400 },
    );
  try {
    if (action === "preview")
      return Response.json({
        preview: await previewAllocation(env.DB, parsed.data),
      });
    const confirmed = confirmAllocationSchema.parse(body);
    return Response.json({
      result: await confirmAllocation(env.DB, confirmed, confirmed.pairs),
    });
  } catch (error) {
    return failure(error);
  }
}
