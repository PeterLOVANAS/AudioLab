import { AuthError } from "@/lib/backend/auth/identity";

/** Bound a cloned request before JSON/multipart parsing, including chunked input.
 * Content-Length is an early rejection only; counted bytes are authoritative.
 * The caller retains the original request for the authorized route handler.
 */
export async function boundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new AuthError(413, "Payload too large.");
  const reader = request.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      // Awaiting cancellation of one tee branch can wait for the route's branch.
      void reader.cancel().catch(() => {});
      throw new AuthError(413, "Payload too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
