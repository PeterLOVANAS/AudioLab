import { ingestionRoute } from "@/lib/backend/http/ingestion-routes";
/** Controlled local canonical ingestion endpoint. */
export async function POST(request: Request) {
  return ingestionRoute(request, "validate");
}
