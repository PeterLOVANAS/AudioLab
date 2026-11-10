/**
 * Labeller Workspace V1: thin, typed HTTP client for EXISTING annotation routes.
 * This module never downloads R2 audio or imports backend services into the browser.
 */
import type { AssignmentSummary } from "@/lib/contracts/assignment-api";
import type {
  AnnotationCurrent,
  AnnotationRevision,
} from "@/lib/contracts/annotation-api";
import type { TaskInstancePreview } from "@/lib/contracts/task-instances";
import type { Answers } from "@/components/workbench/BlockFields";

export type AssignmentDetail = {
  assignment: AssignmentSummary;
  taskInstance: TaskInstancePreview;
};
export type QueuePage = {
  assignments: AssignmentSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store", // drafts and assignment status are mutable
    ...init,
    headers,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      body.issues,
    );
  }
  return payload as T;
}

export function getQueuePage(
  projectId: string,
  labellerId: string,
  cursor?: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ projectId, labellerId, limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return request<QueuePage>(`/api/v1/labeller/queue/page?${query}`, { signal });
}
export function getAssignmentDetail(id: string, signal?: AbortSignal) {
  return request<AssignmentDetail>(
    `/api/v1/assignments/${encodeURIComponent(id)}`,
    { signal },
  );
}
export function getCurrentAnnotation(
  id: string,
  labellerId: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ labellerId });
  return request<AnnotationCurrent>(
    `/api/v1/assignments/${encodeURIComponent(id)}/annotation?${query}`,
    { signal },
  );
}
export function startAssignment(id: string, labellerId: string) {
  return request<{ assignment: AssignmentSummary }>(
    `/api/v1/assignments/${encodeURIComponent(id)}/start`,
    { method: "POST", body: JSON.stringify({ labellerId }) },
  );
}
export function writeAnnotation(
  id: string,
  labellerId: string,
  expectedRevision: number,
  answers: Answers,
  kind: "draft" | "submit",
) {
  return request<{ annotation: AnnotationRevision }>(
    `/api/v1/assignments/${encodeURIComponent(id)}/annotation/${kind}`,
    {
      method: "POST",
      body: JSON.stringify({ labellerId, expectedRevision, answers }),
    },
  );
}
