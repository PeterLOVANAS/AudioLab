import { ingestionRoute } from "@/lib/backend/http/ingestion-routes";
/** Controlled local canonical ingestion endpoint. */
export async function GET(request: Request) {
  return ingestionRoute(request, "inspect");
}
